(function () {
  const INSTRUMENT_ISIN = "IE00B7Y34M31";
  const chart = document.getElementById("priceChart");
  const tooltip = document.getElementById("chartTooltip");
  const timelineGrid = document.getElementById("timelineGrid");
  const transactionGrid = document.getElementById("transactionGrid");
  const chartStatus = document.getElementById("chartStatus");
  const chartTitle = document.getElementById("chartTitle");

  const metricElements = {
    range: document.querySelector('[data-metric="range"]'),
    start: document.querySelector('[data-metric="start"]'),
    end: document.querySelector('[data-metric="end"]'),
    change: document.querySelector('[data-metric="change"]'),
    low: document.querySelector('[data-metric="low"]'),
    high: document.querySelector('[data-metric="high"]'),
    tradeCount: document.querySelector('[data-metric="trade-count"]'),
    realizedPnl: document.querySelector('[data-metric="realized-pnl"]'),
    taxPaid: document.querySelector('[data-metric="tax-paid"]'),
    netPnl: document.querySelector('[data-metric="net-pnl"]'),
  };

  const events = Array.isArray(window.TRUMP_IRAN_EVENTS) ? window.TRUMP_IRAN_EVENTS : [];
  const state = {
    points: [],
    msciPoints: [],
    eventMapping: [],
    transactionMapping: [],
    activeItemId: null,
    chartInstance: null,
  };

  initialize();

  async function initialize() {
    renderTimelinePlaceholder();
    renderTransactionPlaceholder();

    try {
      const text = window.APP_DATASETS && typeof window.APP_DATASETS.priceCsv === "string"
        ? window.APP_DATASETS.priceCsv
        : "";
      const msciText = window.APP_DATASETS && typeof window.APP_DATASETS.msciWorldCsv === "string"
        ? window.APP_DATASETS.msciWorldCsv
        : "";
      const transactionsText = window.APP_DATASETS && typeof window.APP_DATASETS.transactionsCsv === "string"
        ? window.APP_DATASETS.transactionsCsv
        : "";

      if (!text.trim()) {
        throw new Error("Kursdaten konnten nicht initialisiert werden.");
      }

      const points = parseCsv(text);
      const msciPoints = msciText.trim() ? parseCsv(msciText) : [];

      if (!points.length) {
        throw new Error("CSV enthält keine verwertbaren Zeilen.");
      }

      const transactions = transactionsText
        ? parseTransactionsCsv(transactionsText, points[0].date, points[points.length - 1].date)
        : [];
      const transactionSummary = calculateTransactionSummary(transactions);

      state.points = points;
      state.msciPoints = msciPoints;
      state.eventMapping = mapEventsToTradingDays(points, events);
      state.transactionMapping = mapTransactionsToTradingDays(points, transactionSummary.transactions);

      renderMetrics(points);
      renderTransactionMetrics(transactionSummary, points[0].currency);
      renderChart(points, msciPoints, state.eventMapping, state.transactionMapping);
      renderTransactions(state.transactionMapping);
      renderTimeline(state.eventMapping);
      chartTitle.textContent = `${formatDate(points[0].date)} bis ${formatDate(points[points.length - 1].date)}`;
      chartStatus.textContent = `${points.length} Handelstage geladen, ${state.transactionMapping.length} Transaktionen eingeblendet.`;
    } catch (error) {
      chartStatus.textContent = error.message;
      chartTitle.textContent = "Daten konnten nicht geladen werden";
      renderChartFallback();
    }
  }

  function parseCsv(text) {
    return text
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(";"))
      .filter((columns) => columns.length >= 7)
      .map(([date, open, high, low, close, currency, volume]) => ({
        rawDate: date,
        date: parseGermanDate(date),
        open: parseGermanNumber(open),
        high: parseGermanNumber(high),
        low: parseGermanNumber(low),
        close: parseGermanNumber(close),
        currency,
        volume: Number.parseInt(volume, 10),
      }))
      .filter((point) => point.date instanceof Date && !Number.isNaN(point.close))
      .sort((left, right) => left.date - right.date);
  }

  function parseGermanDate(value) {
    const [day, month, year] = value.split(".").map(Number);
    return new Date(year, month - 1, day);
  }

  function parseIsoDate(value) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  function parseGermanNumber(value) {
    return Number.parseFloat(value.replace(/\./g, "").replace(",", "."));
  }

  function parseTransactionsCsv(text, rangeStart, rangeEnd) {
    return text
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(";"))
      .filter((columns) => columns.length >= 14)
      .map(([date, time, status, reference, description, assetType, type, isin, shares, price, amount, fee, tax, currency]) => ({
        date: parseIsoDate(date),
        time,
        status: stripQuotes(status),
        reference: stripQuotes(reference),
        description: stripQuotes(description),
        assetType: stripQuotes(assetType),
        type: stripQuotes(type),
        isin: stripQuotes(isin),
        shares: parseGermanNumber(shares),
        price: parseGermanNumber(price),
        amount: parseGermanNumber(amount),
        fee: parseGermanNumber(fee),
        tax: parseGermanNumber(tax),
        currency: stripQuotes(currency),
      }))
      .filter((transaction) => {
        const inRange = transaction.date >= rangeStart && transaction.date <= rangeEnd;
        return inRange && transaction.status === "Executed" && transaction.isin === INSTRUMENT_ISIN;
      })
      .sort((left, right) => left.date - right.date);
  }

  function mapEventsToTradingDays(points, rawEvents) {
    return rawEvents.map((event, index) => {
      const eventDate = new Date(`${event.date}T00:00:00`);
      const mappedPoint = findNearestTradingDay(points, eventDate);

      return {
        ...event,
        id: event.id || `event-${index + 1}`,
        eventDate,
        mappedPoint,
      };
    });
  }

  function mapTransactionsToTradingDays(points, rawTransactions) {
    return rawTransactions.map((transaction, index) => ({
      ...transaction,
      id: `transaction-${index + 1}`,
      mappedPoint: findNearestTradingDay(points, transaction.date),
    }));
  }

  function calculateTransactionSummary(rawTransactions) {
    const lots = [];
    let realizedPnl = 0;
    let totalTax = 0;

    const transactions = rawTransactions.map((transaction) => {
      if (transaction.type === "Buy") {
        lots.push({ shares: transaction.shares, price: transaction.price });
        return {
          ...transaction,
          realizedPnl: 0,
          netPnl: -transaction.tax,
          matchedShares: 0,
        };
      }

      let sharesToMatch = transaction.shares;
      let costBasis = 0;
      let matchedShares = 0;

      while (sharesToMatch > 0 && lots.length) {
        const currentLot = lots[0];
        const usedShares = Math.min(currentLot.shares, sharesToMatch);
        costBasis += usedShares * currentLot.price;
        matchedShares += usedShares;
        currentLot.shares -= usedShares;
        sharesToMatch -= usedShares;

        if (currentLot.shares <= 0.000001) {
          lots.shift();
        }
      }

      const proceeds = transaction.shares * transaction.price;
      const realizedForTrade = matchedShares > 0 ? proceeds - costBasis : 0;
      realizedPnl += realizedForTrade;
      totalTax += transaction.tax;

      return {
        ...transaction,
        matchedShares,
        costBasis,
        proceeds,
        unmatchedShares: sharesToMatch,
        realizedPnl: realizedForTrade,
        netPnl: realizedForTrade - transaction.tax,
      };
    });

    return {
      transactions,
      tradeCount: transactions.length,
      realizedPnl,
      totalTax,
      netPnl: realizedPnl - totalTax,
    };
  }

  function findNearestTradingDay(points, targetDate) {
    return points.reduce((closest, current) => {
      if (!closest) {
        return current;
      }

      const currentDistance = Math.abs(current.date - targetDate);
      const closestDistance = Math.abs(closest.date - targetDate);
      return currentDistance < closestDistance ? current : closest;
    }, null);
  }

  function renderMetrics(points) {
    const first = points[0];
    const last = points[points.length - 1];
    const closes = points.map((point) => point.close);
    const low = Math.min(...closes);
    const high = Math.max(...closes);
    const change = last.close - first.close;
    const changePct = (change / first.close) * 100;

    metricElements.range.textContent = `${formatDate(first.date)} - ${formatDate(last.date)}`;
    metricElements.start.textContent = formatCurrency(first.close, first.currency);
    metricElements.end.textContent = formatCurrency(last.close, last.currency);
    metricElements.change.textContent = `${change >= 0 ? "+" : ""}${formatCurrency(change, first.currency)} (${changePct.toFixed(1)}%)`;
    metricElements.change.classList.toggle("value-positive", change >= 0);
    metricElements.change.classList.toggle("value-negative", change < 0);
    metricElements.low.textContent = formatCurrency(low, first.currency);
    metricElements.high.textContent = formatCurrency(high, first.currency);
  }

  function renderTransactionMetrics(summary, currencyCode) {
    metricElements.tradeCount.textContent = String(summary.tradeCount);
    metricElements.realizedPnl.textContent = formatSignedCurrency(summary.realizedPnl, currencyCode);
    metricElements.taxPaid.textContent = formatCurrency(summary.totalTax, currencyCode);
    metricElements.netPnl.textContent = formatSignedCurrency(summary.netPnl, currencyCode);

    metricElements.realizedPnl.classList.toggle("value-positive", summary.realizedPnl >= 0);
    metricElements.realizedPnl.classList.toggle("value-negative", summary.realizedPnl < 0);
    metricElements.netPnl.classList.toggle("value-positive", summary.netPnl >= 0);
    metricElements.netPnl.classList.toggle("value-negative", summary.netPnl < 0);
  }

  function renderChart(points, msciPoints, eventMapping, transactionMapping) {
    const canvas = document.getElementById("priceChart");
    const ctx = canvas.getContext("2d");

    if (state.chartInstance) {
      state.chartInstance.destroy();
      state.chartInstance = null;
    }

    const closes = points.map((p) => p.close);
    const msciCloses = msciPoints.length > 0 ? msciPoints.map((p) => p.close) : [];
    const allCloses = msciCloses.length > 0 ? [...closes, ...msciCloses] : closes;
    const minPrice = Math.min(...allCloses);
    const maxPrice = Math.max(...allCloses);
    const yPad = (maxPrice - minPrice) * 0.06;

    const eventScatterData = eventMapping
      .filter((e) => e.mappedPoint)
      .map((e) => ({ x: e.mappedPoint.date.getTime(), y: e.mappedPoint.close, _ref: e, _type: "event" }));

    const buyScatterData = transactionMapping
      .filter((t) => t.mappedPoint && t.type === "Buy")
      .map((t) => ({ x: t.mappedPoint.date.getTime(), y: t.mappedPoint.close, _ref: t, _type: "transaction" }));

    const sellScatterData = transactionMapping
      .filter((t) => t.mappedPoint && t.type === "Sell")
      .map((t) => ({ x: t.mappedPoint.date.getTime(), y: t.mappedPoint.close, _ref: t, _type: "transaction" }));

    const datasets = [
      {
        label: "S&P 500 3x",
        data: points.map((p) => ({ x: p.date.getTime(), y: p.close })),
        borderColor: "#0b6e4f",
        backgroundColor: "rgba(11,110,79,0.12)",
        fill: true,
        tension: 0,
        pointRadius: 0,
        borderWidth: 3,
        order: 3,
      },
    ];

    if (msciPoints.length > 0) {
      datasets.push({
        label: "MSCI World",
        data: msciPoints.map((p) => ({ x: p.date.getTime(), y: p.close })),
        borderColor: "#5c6c66",
        borderDash: [5, 5],
        backgroundColor: "transparent",
        fill: false,
        tension: 0,
        pointRadius: 0,
        borderWidth: 2,
        order: 2,
      });
    }

    datasets.push(
      {
        label: "Ereignisse",
        type: "scatter",
        data: eventScatterData,
        backgroundColor: "#f5c400",
        borderColor: "rgba(255,250,241,0.95)",
        borderWidth: 3,
        pointRadius: 8,
        pointHoverRadius: 10,
        order: 0,
      },
      {
        label: "Kauf",
        type: "scatter",
        data: buyScatterData,
        backgroundColor: "#1f8f63",
        borderColor: "rgba(255,250,241,0.95)",
        borderWidth: 2,
        pointStyle: "rect",
        pointRadius: 8,
        pointHoverRadius: 10,
        order: 1,
      },
      {
        label: "Verkauf",
        type: "scatter",
        data: sellScatterData,
        backgroundColor: "#b7472f",
        borderColor: "rgba(255,250,241,0.95)",
        borderWidth: 2,
        pointStyle: "rect",
        pointRadius: 8,
        pointHoverRadius: 10,
        order: 1,
      },
    );

    const currencyCode = points[0].currency;
    state.chartInstance = new Chart(ctx, {
      type: "line",
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 960 / 460,
        animation: false,
        parsing: false,
        scales: {
          x: {
            type: "linear",
            min: points[0].date.getTime(),
            max: points[points.length - 1].date.getTime(),
            ticks: {
              maxTicksLimit: 3,
              callback: (value) =>
                new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value)),
              color: "#5c6c66",
              font: { size: 13 },
            },
            grid: { color: "rgba(24,34,34,0.10)" },
          },
          y: {
            min: minPrice - yPad,
            max: maxPrice + yPad,
            ticks: {
              maxTicksLimit: 5,
              callback: (value) => formatCurrency(value, currencyCode),
              color: "#5c6c66",
              font: { size: 13 },
            },
            grid: { color: "rgba(24,34,34,0.10)" },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
      },
    });

    canvas.addEventListener("mousemove", handleChartMouseMove);
    canvas.addEventListener("mouseleave", clearActiveItem);
  }

  function handleChartMouseMove(event) {
    if (!state.chartInstance) return;
    const elements = state.chartInstance.getElementsAtEventForMode(event, "point", { intersect: true }, false);
    if (!elements.length) {
      clearActiveItem();
      return;
    }
    const el = elements[0];
    const dataPoint = state.chartInstance.data.datasets[el.datasetIndex].data[el.index];
    if (!dataPoint || !dataPoint._ref) {
      clearActiveItem();
      return;
    }
    const canvasRect = chart.getBoundingClientRect();
    const x = canvasRect.left + el.element.x;
    const y = canvasRect.top + el.element.y;
    if (dataPoint._type === "event") {
      setActiveItem(dataPoint._ref.id, x, y, buildEventTooltip(dataPoint._ref));
    } else {
      setActiveItem(dataPoint._ref.id, x, y, buildTransactionTooltip(dataPoint._ref));
    }
  }

  function renderTimeline(eventMapping) {
    if (!eventMapping.length) {
      renderTimelinePlaceholder();
      return;
    }

    timelineGrid.innerHTML = "";
    eventMapping.forEach((event) => {
      const card = document.createElement("article");
      card.className = "timeline-card";
      card.dataset.eventId = event.id;
      card.innerHTML = `
        <div class="timeline-meta">
          <span class="timeline-badge">${escapeHtml(event.relevance || "einordnung")}</span>
          <strong>${formatDate(event.eventDate)}</strong>
          <small>Gemappt auf Handelstag: ${formatDate(event.mappedPoint.date)}</small>
        </div>
        <div>
          <h3>${escapeHtml(event.title)}</h3>
          <p>${escapeHtml(event.summary || "")}</p>
          ${event.marketNote ? `<p><strong>Marktumfeld:</strong> ${escapeHtml(event.marketNote)}</p>` : ""}
        </div>
        <div class="timeline-source">
          <strong>Quelle</strong>
          <p>${escapeHtml(event.source || "Quelle fehlt")}</p>
        </div>
      `;

      card.addEventListener("mouseenter", () => {
        if (!event.mappedPoint) {
          return;
        }
        const coordinates = getChartCoordinatesForPoint(event.mappedPoint);
        setActiveItem(event.id, coordinates.x, coordinates.y, buildEventTooltip(event));
      });

      card.addEventListener("mouseleave", clearActiveItem);
      timelineGrid.appendChild(card);
    });
  }

  function renderTransactions(transactionMapping) {
    if (!transactionMapping.length) {
      renderTransactionPlaceholder();
      return;
    }

    transactionGrid.innerHTML = "";
    transactionMapping
      .slice()
      .reverse()
      .forEach((transaction) => {
        const card = document.createElement("article");
        const transactionType = transaction.type.toLowerCase();
        card.className = `timeline-card transaction-card transaction-${transactionType}`;
        card.dataset.eventId = transaction.id;
        card.innerHTML = `
          <div class="timeline-meta">
            <span class="timeline-badge">${escapeHtml(transaction.type)}</span>
            <strong>${formatDate(transaction.date)}</strong>
            <small>${escapeHtml(transaction.time)}</small>
          </div>
          <div>
            <h3>${escapeHtml(transaction.description)}</h3>
            <p>${formatNumber(transaction.shares)} Anteile zu ${formatCurrency(transaction.price, transaction.currency)}</p>
            <p><strong>Gesamt:</strong> ${formatCurrency(transaction.amount, transaction.currency)}</p>
            ${transaction.type === "Sell" ? `<p><strong>Realisiert:</strong> ${formatSignedCurrency(transaction.realizedPnl, transaction.currency)}</p>` : ""}
          </div>
          <div class="timeline-source">
            <strong>Abwicklung</strong>
            <p>${escapeHtml(transaction.reference)}</p>
            <p>Steuer: ${formatCurrency(transaction.tax, transaction.currency)}</p>
            ${transaction.type === "Sell" ? `<p>Netto: ${formatSignedCurrency(transaction.netPnl, transaction.currency)}</p>` : ""}
          </div>
        `;

        card.addEventListener("mouseenter", () => {
          const coordinates = getChartCoordinatesForPoint(transaction.mappedPoint);
          setActiveItem(transaction.id, coordinates.x, coordinates.y, buildTransactionTooltip(transaction));
        });

        card.addEventListener("mouseleave", clearActiveItem);
        transactionGrid.appendChild(card);
      });
  }

  function renderTimelinePlaceholder() {
    timelineGrid.innerHTML = `
      <article class="empty-state">
        <h3>Event-Daten vorbereitet</h3>
        <p>
          In <span class="mono">events.js</span> können verifizierte Paraphrasen zu Trump und Iran
          eingetragen werden. Jeder Eintrag erwartet Datum, Titel, Summary, Quelle, Relevanz und
          optional eine kurze Markteinordnung.
        </p>
      </article>
    `;
  }

  function renderTransactionPlaceholder() {
    transactionGrid.innerHTML = `
      <article class="empty-state">
        <h3>Transaktionsdaten vorbereitet</h3>
        <p>
          Sobald die Broker-CSV verfügbar ist, werden hier nur ausgeführte Käufe und Verkäufe
          für dieselbe ISIN innerhalb des dargestellten Zeitraums gezeigt.
        </p>
      </article>
    `;
  }

  function renderChartFallback() {
    chartStatus.textContent = "Die Visualisierung konnte nicht geladen werden.";
  }

  function setActiveItem(itemId, x, y, tooltipContent) {
    // Prevent unnecessary DOM updates if the same item is already active
    if (state.activeItemId === itemId) {
      return;
    }

    state.activeItemId = itemId;

    document.querySelectorAll(".timeline-card").forEach((card) => {
      card.classList.toggle("is-active", card.dataset.eventId === itemId);
    });

    tooltip.hidden = false;
    tooltip.innerHTML = tooltipContent;

    // Position tooltip and adjust for bounds
    requestAnimationFrame(() => {
      const tooltipRect = tooltip.getBoundingClientRect();

      let tooltipCenterX = x;
      let tooltipTopY = y;

      const tooltipWidth = tooltipRect.width;
      const tooltipHeight = tooltipRect.height;

      // Clamp horizontal position to keep tooltip fully visible
      const minLeftPx = tooltipWidth / 2 + 8;
      const maxLeftPx = window.innerWidth - tooltipWidth / 2 - 8;
      tooltipCenterX = Math.max(minLeftPx, Math.min(maxLeftPx, tooltipCenterX));

      // Check if there's enough space above; if not, show below
      const spaceAbove = tooltipTopY;
      const spaceBelow = window.innerHeight - tooltipTopY;
      const gap = 14;

      let finalTop;
      if (spaceAbove >= tooltipHeight + gap) {
        // Show above with gap
        finalTop = tooltipTopY - tooltipHeight - gap;
      } else if (spaceBelow >= tooltipHeight + gap) {
        // Show below with gap
        finalTop = tooltipTopY + gap;
      } else {
        // Not enough space, show above by default
        finalTop = tooltipTopY - tooltipHeight - gap;
      }

      // Apply styles (transform: translate(-50%, 0) centers horizontally, top/left position vertically)
      tooltip.style.left = `${tooltipCenterX}px`;
      tooltip.style.top = `${finalTop}px`;
    });
  }

  function clearActiveItem() {
    state.activeItemId = null;
    tooltip.hidden = true;
    document.querySelectorAll(".timeline-card").forEach((card) => card.classList.remove("is-active"));
  }

  function truncate(text, max) {
    const s = String(text || "");
    return s.length > max ? `${s.slice(0, max)}\u2026` : s;
  }

  function buildEventTooltip(event) {
    return `
      <strong>${escapeHtml(truncate(event.title, 80))}</strong><br />
      <span>${formatDate(event.eventDate)}</span><br />
      <span>${escapeHtml(truncate(event.summary, 250))}</span>
    `;
  }

  function buildTransactionTooltip(transaction) {
    return `
      <strong>${escapeHtml(transaction.type)}: ${escapeHtml(transaction.description)}</strong><br />
      <span>${formatDate(transaction.date)} ${escapeHtml(transaction.time)}</span><br />
      <span>${formatNumber(transaction.shares)} Anteile zu ${formatCurrency(transaction.price, transaction.currency)}</span><br />
      ${transaction.type === "Sell" ? `<span>Realisiert: ${formatSignedCurrency(transaction.realizedPnl, transaction.currency)} | Steuer: ${formatCurrency(transaction.tax, transaction.currency)}</span>` : `<span>Steuer: ${formatCurrency(transaction.tax, transaction.currency)}</span>`}
    `;
  }

  function getChartCoordinatesForPoint(point) {
    if (!state.chartInstance) return { x: 0, y: 0 };
    const canvasRect = chart.getBoundingClientRect();
    return {
      x: canvasRect.left + state.chartInstance.scales.x.getPixelForValue(point.date.getTime()),
      y: canvasRect.top + state.chartInstance.scales.y.getPixelForValue(point.close),
    };
  }

  function formatCurrency(value, currencyCode) {
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: currencyCode || "EUR",
      maximumFractionDigits: 2,
    }).format(value);
  }

  function formatSignedCurrency(value, currencyCode) {
    const formatted = formatCurrency(Math.abs(value), currencyCode);
    if (value > 0) {
      return `+${formatted}`;
    }
    if (value < 0) {
      return `-${formatted}`;
    }
    return formatted;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("de-DE", {
      maximumFractionDigits: 3,
    }).format(value);
  }

  function formatDate(date, compact) {
    return new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: compact ? "2-digit" : "long",
      year: "numeric",
    }).format(date);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function stripQuotes(value) {
    return String(value).replace(/^"|"$/g, "");
  }
})();