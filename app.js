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
    eventMapping: [],
    transactionMapping: [],
    activeItemId: null,
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
        throw new Error("CSV enthalt keine verwertbaren Zeilen.");
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
    const width = 960;
    const height = 460;
    const padding = { top: 28, right: 28, bottom: 48, left: 74 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const closes = points.map((point) => point.close);
    const msciCloses = msciPoints.length > 0 ? msciPoints.map((point) => point.close) : [];
    const allCloses = msciCloses.length > 0 ? [...closes, ...msciCloses] : closes;
    const minPrice = Math.min(...allCloses);
    const maxPrice = Math.max(...allCloses);
    const minX = points[0].date.getTime();
    const maxX = points[points.length - 1].date.getTime();

    chart.innerHTML = `
      <defs>
        <linearGradient id="priceAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(11, 110, 79, 0.26)"></stop>
          <stop offset="100%" stop-color="rgba(11, 110, 79, 0)"></stop>
        </linearGradient>
      </defs>
    `;

    const xScale = (value) => padding.left + ((value - minX) / (maxX - minX || 1)) * innerWidth;
    const yScale = (value) => padding.top + innerHeight - ((value - minPrice) / (maxPrice - minPrice || 1)) * innerHeight;
    const linePath = points
      .map((point, index) => `${index === 0 ? "M" : "L"}${xScale(point.date.getTime()).toFixed(2)},${yScale(point.close).toFixed(2)}`)
      .join(" ");
    const areaPath = `${linePath} L ${xScale(points[points.length - 1].date.getTime()).toFixed(2)},${(padding.top + innerHeight).toFixed(2)} L ${xScale(points[0].date.getTime()).toFixed(2)},${(padding.top + innerHeight).toFixed(2)} Z`;
    
    const msciLinePath = msciPoints.length > 0
      ? msciPoints
        .map((point, index) => `${index === 0 ? "M" : "L"}${xScale(point.date.getTime()).toFixed(2)},${yScale(point.close).toFixed(2)}`)
        .join(" ")
      : "";

    for (let index = 0; index < 5; index += 1) {
      const ratio = index / 4;
      const yValue = minPrice + (maxPrice - minPrice) * ratio;
      const y = yScale(yValue);
      chart.appendChild(svgElement("line", {
        x1: padding.left,
        x2: width - padding.right,
        y1: y,
        y2: y,
        class: "grid-line",
      }));
      chart.appendChild(svgElement("text", {
        x: 14,
        y: y + 5,
        class: "axis-label",
      }, formatCurrency(yValue, points[0].currency)));
    }

    const xTickIndices = [0, Math.floor(points.length / 2), points.length - 1];
    xTickIndices.forEach((pointIndex) => {
      const point = points[pointIndex];
      chart.appendChild(svgElement("text", {
        x: xScale(point.date.getTime()),
        y: height - 14,
        class: "axis-label",
        "text-anchor": pointIndex === 0 ? "start" : pointIndex === points.length - 1 ? "end" : "middle",
      }, formatDate(point.date, true)));
    });

    chart.appendChild(svgElement("path", { d: areaPath, class: "price-area" }));
    chart.appendChild(svgElement("path", { d: linePath, class: "price-path" }));
    if (msciLinePath) {
      chart.appendChild(svgElement("path", { d: msciLinePath, class: "msci-path", "stroke-dasharray": "5,5" }));
    }

    transactionMapping.forEach((transaction) => {
      if (!transaction.mappedPoint) {
        return;
      }

      const x = xScale(transaction.mappedPoint.date.getTime());
      const y = yScale(transaction.mappedPoint.close);

      const activate = () => setActiveItem(transaction.id, x, y, buildTransactionTooltip(transaction));
      const deactivate = () => clearActiveItem();

      // Create invisible larger hit area first to prevent flickering
      const hitArea = svgElement("rect", {
        x: x - 12,
        y: y - 12,
        width: 24,
        height: 24,
        rx: 4,
        fill: "transparent",
        "pointer-events": "all",
        "data-hit-area": "true",
      });

      hitArea.addEventListener("mouseenter", activate);
      hitArea.addEventListener("focus", activate);
      hitArea.addEventListener("mouseleave", deactivate);
      hitArea.addEventListener("blur", deactivate);

      chart.appendChild(hitArea);

      // Create visible marker on top
      const marker = svgElement("rect", {
        x: x - 7,
        y: y - 7,
        width: 14,
        height: 14,
        rx: 4,
        class: `transaction-marker transaction-marker-${transaction.type.toLowerCase()}`,
        tabindex: 0,
        role: "button",
        "data-item-id": transaction.id,
        "aria-label": `${transaction.type} ${transaction.shares} Anteile am ${formatDate(transaction.date)}`,
        "pointer-events": "none",
      });

      chart.appendChild(marker);
    });

    eventMapping.forEach((event) => {
      if (!event.mappedPoint) {
        return;
      }

      const x = xScale(event.mappedPoint.date.getTime());
      const y = yScale(event.mappedPoint.close);
      const stemTop = Math.max(padding.top + 24, y - 62);
      const stem = svgElement("line", {
        x1: x,
        x2: x,
        y1: stemTop,
        y2: y - 12,
        class: "event-stem",
      });

      const activate = () => setActiveItem(event.id, x, y, buildEventTooltip(event));
      const deactivate = () => clearActiveItem();

      // Create invisible larger hit area first to prevent flickering
      const hitArea = svgElement("circle", {
        cx: x,
        cy: y,
        r: 16,
        fill: "transparent",
        "pointer-events": "all",
        "data-hit-area": "true",
      });

      hitArea.addEventListener("mouseenter", activate);
      hitArea.addEventListener("focus", activate);
      hitArea.addEventListener("mouseleave", deactivate);
      hitArea.addEventListener("blur", deactivate);

      // Create visible marker on top
      const marker = svgElement("circle", {
        cx: x,
        cy: y,
        r: 8,
        class: "event-marker",
        tabindex: 0,
        role: "button",
        "data-item-id": event.id,
        "aria-label": `${event.title} am ${formatDate(event.eventDate)}`,
        "pointer-events": "none",
      });

      chart.appendChild(stem);
      chart.appendChild(hitArea);
      chart.appendChild(marker);
    });
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

        const width = 960;
        const padding = { left: 74, right: 28 };
        const innerWidth = width - padding.left - padding.right;
        const minX = state.points[0].date.getTime();
        const maxX = state.points[state.points.length - 1].date.getTime();
        const x = padding.left + ((event.mappedPoint.date.getTime() - minX) / (maxX - minX || 1)) * innerWidth;
        const closes = state.points.map((point) => point.close);
        const msciCloses = state.msciPoints && state.msciPoints.length > 0 ? state.msciPoints.map((point) => point.close) : [];
        const allCloses = msciCloses.length > 0 ? [...closes, ...msciCloses] : closes;
        const minPrice = Math.min(...allCloses);
        const maxPrice = Math.max(...allCloses);
        const innerHeight = 460 - 28 - 48;
        const y = 28 + innerHeight - ((event.mappedPoint.close - minPrice) / (maxPrice - minPrice || 1)) * innerHeight;
        setActiveItem(event.id, x, y, buildEventTooltip(event));
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
          In <span class="mono">events.js</span> konnen verifizierte Paraphrasen zu Trump und Iran
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
          Sobald die Broker-CSV verfuegbar ist, werden hier nur ausgefuehrte Kaeufe und Verkaeufe
          fuer dieselbe ISIN innerhalb des dargestellten Zeitraums gezeigt.
        </p>
      </article>
    `;
  }

  function renderChartFallback() {
    chart.innerHTML = "";
    chart.appendChild(svgElement("text", {
      x: 54,
      y: 120,
      class: "axis-label",
    }, "Die Visualisierung erscheint, sobald die CSV uber HTTP geladen wird."));
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

    chart.querySelectorAll(".event-marker, .transaction-marker").forEach((marker) => {
      marker.classList.toggle("is-active", marker.getAttribute("data-item-id") === itemId);
    });

    tooltip.hidden = false;
    tooltip.innerHTML = tooltipContent;

    // Position tooltip and adjust for bounds
    requestAnimationFrame(() => {
      const tooltipRect = tooltip.getBoundingClientRect();
      const chartStage = chart.parentElement;
      const chartStageRect = chartStage.getBoundingClientRect();
      
      let tooltipCenterX = (x / 960) * chart.clientWidth;
      let tooltipTopY = (y / 460) * chart.clientHeight;

      const tooltipWidth = tooltipRect.width;
      const tooltipHeight = tooltipRect.height;

      // Clamp horizontal position to keep tooltip fully visible
      const minLeftPx = tooltipWidth / 2;
      const maxLeftPx = chart.clientWidth - tooltipWidth / 2;
      tooltipCenterX = Math.max(minLeftPx, Math.min(maxLeftPx, tooltipCenterX));

      // Check if there's enough space above; if not, show below
      const spaceAbove = tooltipTopY;
      const spaceBelow = chart.clientHeight - tooltipTopY;
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
    chart.querySelectorAll(".event-marker, .transaction-marker").forEach((marker) => marker.classList.remove("is-active"));
  }

  function buildEventTooltip(event) {
    return `
      <strong>${escapeHtml(event.title)}</strong><br />
      <span>${formatDate(event.eventDate)}</span><br />
      <span>${escapeHtml(event.summary || "")}</span>
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
    const width = 960;
    const height = 460;
    const padding = { top: 28, right: 28, bottom: 48, left: 74 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const closes = state.points.map((entry) => entry.close);
    const msciCloses = state.msciPoints && state.msciPoints.length > 0 ? state.msciPoints.map((entry) => entry.close) : [];
    const allCloses = msciCloses.length > 0 ? [...closes, ...msciCloses] : closes;
    const minPrice = Math.min(...allCloses);
    const maxPrice = Math.max(...allCloses);
    const minX = state.points[0].date.getTime();
    const maxX = state.points[state.points.length - 1].date.getTime();

    return {
      x: padding.left + ((point.date.getTime() - minX) / (maxX - minX || 1)) * innerWidth,
      y: padding.top + innerHeight - ((point.close - minPrice) / (maxPrice - minPrice || 1)) * innerHeight,
    };
  }

  function svgElement(tagName, attributes, textContent) {
    const namespace = "http://www.w3.org/2000/svg";
    const element = document.createElementNS(namespace, tagName);
    Object.entries(attributes).forEach(([key, value]) => {
      element.setAttribute(key, String(value));
    });
    if (textContent) {
      element.textContent = textContent;
    }
    return element;
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