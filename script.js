const $ = (selector) => document.querySelector(selector);
const PIECES = {
  wk:"♚", wq:"♛", wr:"♜", wb:"♝", wn:"♞", wp:"♟",
  bk:"♚", bq:"♛", br:"♜", bb:"♝", bn:"♞", bp:"♟"
};
const app = {
  chess: new Chess(),
  timeline: [],
  cursor: 0,
  flipped: false,
  selected: null,
  lastMove: null,
  archive: [],
  positionIndex: new Map(),
  username: localStorage.getItem("chessExplorer.username") || "deepsloth",
  engine: null,
  engineReady: false,
  enginePendingAnalysis: false,
  engineStartupTimer: null,
  engineDepth: Math.min(22, Math.max(8, Number(localStorage.getItem("chessExplorer.engineDepth")) || 16)),
  engineTime: Number(localStorage.getItem("chessExplorer.engineTime")) || 0,
  engineMultiPv: Number(localStorage.getItem("chessExplorer.engineMultiPv")) || 3,
  engineStrength: Number(localStorage.getItem("chessExplorer.engineStrength") ?? 20),
  engineInfinite: false,
  engineLines: new Map(),
  evalByPly: new Map(),
  bestMoveByPly: new Map(),
  savedPositions: loadSavedPositions(),
  engineTimer: null
};

function loadSavedPositions() {
  try {
    const saved = JSON.parse(localStorage.getItem("chessExplorer.savedPositions") || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
}

const OPENINGS = [
  ["e4 c5", "Sicilian Defense"], ["e4 e6", "French Defense"], ["e4 c6", "Caro-Kann Defense"],
  ["e4", "King's Pawn Game"], ["d4", "Queen's Pawn Game"],
  ["e4 e5 Nf3 Nc6 Bb5", "Ruy López"], ["e4 e5 Nf3 Nc6 Bc4", "Italian Game"],
  ["e4 e5 Nf3 Nf6", "Petrov's Defense"], ["e4 d5", "Scandinavian Defense"],
  ["e4 d6", "Pirc Defense"], ["e4 Nf6", "Alekhine's Defense"], ["e4 g6", "Modern Defense"],
  ["d4 d5 c4", "Queen's Gambit"], ["d4 Nf6 c4 g6", "King's Indian Defense"],
  ["d4 Nf6 c4 e6 Nc3 Bb4", "Nimzo-Indian Defense"], ["d4 Nf6 c4 e6 Nf3 b6", "Queen's Indian Defense"],
  ["d4 Nf6 c4 c5 d5 e6", "Benoni Defense"], ["d4 f5", "Dutch Defense"],
  ["c4", "English Opening"], ["Nf3", "Réti Opening"], ["b3", "Nimzo-Larsen Attack"],
  ["f4", "Bird Opening"], ["e4 e5 f4", "King's Gambit"], ["d4 d5 c4 e6", "Queen's Gambit Declined"],
  ["d4 d5 c4 c6", "Slav Defense"], ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", "Sicilian Najdorf"],
  ["e4 c5 Nf3 Nc6 d4 cxd4 Nxd4", "Open Sicilian"], ["e4 c5 Nf3 e6", "Sicilian Taimanov/Kan"],
  ["e4 e5 Nf3 Nc6 d4", "Scotch Game"], ["e4 e5 Nf3 Nc6 Nc3", "Four Knights Game"]
].sort((a, b) => b[0].split(" ").length - a[0].split(" ").length);

function openingForMoves(moves) {
  const played = moves.join(" ");
  return OPENINGS.find(([moves]) => played === moves || played.startsWith(`${moves} `))?.[1] || "";
}

function openingName() {
  return openingForMoves(app.chess.history());
}

function isBookSequence(ply) {
  if (!ply || ply > 20) return false;
  const played = app.timeline.slice(0, ply).map(move => move.san).join(" ");
  return OPENINGS.some(([line]) => line.split(" ").length > 1 && (line === played || line.startsWith(`${played} `)));
}

function numericEvaluation(score) {
  if (typeof score !== "string") return null;
  if (score.startsWith("M")) return Number(score.slice(1)) >= 0 ? 100 : -100;
  const value = Number(score);
  return Number.isFinite(value) ? value : null;
}

function classifyTimeline() {
  for (let ply = 1; ply <= app.timeline.length; ply++) {
    const before = app.evalByPly.get(ply - 1);
    const after = app.evalByPly.get(ply);
    if (before == null || after == null) continue;
    const move = app.timeline[ply - 1];
    const uci = `${move.from}${move.to}${move.promotion || ""}`;
    const moverIsWhite = ply % 2 === 1;
    const loss = Math.max(0, moverIsWhite ? before - after : after - before);
    let label;
    if (isBookSequence(ply)) label = "Book";
    else if (app.bestMoveByPly.get(ply - 1) === uci || loss <= .08) label = "Best";
    else if (loss <= .25) label = "Excellent";
    else if (loss <= .60) label = "Good";
    else if (loss <= 1.20) label = "Inaccuracy";
    else if (loss <= 2.50) label = "Mistake";
    else label = "Blunder";
    move.classification = label;
    move.evalLoss = loss;
  }
}

function positionKey(fen) {
  return fen.split(/\s+/).slice(0, 4).join(" ");
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(node.timer);
  node.timer = setTimeout(() => node.classList.remove("show"), 1800);
}

function splitPgnGames(text) {
  const normalized = text.replace(/\r/g, "").trim();
  if (!normalized) return [];
  const starts = [...normalized.matchAll(/^\[Event\s/mg)].map(m => m.index);
  if (starts.length < 2) return [normalized];
  return starts.map((start, i) => normalized.slice(start, starts[i + 1] ?? normalized.length).trim()).filter(Boolean);
}

function resultForUser(headers, username) {
  const white = (headers.White || "").toLowerCase();
  const black = (headers.Black || "").toLowerCase();
  const user = username.toLowerCase();
  const result = headers.Result || "*";
  if (result === "1/2-1/2") return "draw";
  if (result === "*") return "unknown";
  const userWhite = white === user;
  const userBlack = black === user;
  if (!userWhite && !userBlack) return "unknown";
  return (result === "1-0") === userWhite ? "win" : "loss";
}

function parseArchive(text, username, source = "import") {
  const parsed = [];
  for (const pgn of splitPgnGames(text)) {
    try {
      const game = new Chess();
      game.loadPgn(pgn, { strict: false });
      const headers = game.getHeaders();
      const moves = game.history({ verbose: true });
      if (!moves.length) continue;
      parsed.push({
        pgn,
        source,
        headers,
        username,
        result: resultForUser(headers, username),
        userColor: (headers.White || "").toLowerCase() === username.toLowerCase() ? "w" :
          (headers.Black || "").toLowerCase() === username.toLowerCase() ? "b" : null,
        moves: moves.map(m => ({ san:m.san, from:m.from, to:m.to, promotion:m.promotion || null }))
      });
    } catch (error) {
      console.warn("Skipped invalid PGN", error);
    }
  }
  return parsed;
}

function timeControlCategory(value = "") {
  if (!value || value.includes("/")) return "daily";
  const seconds = Number(value.split("+")[0]);
  if (seconds < 180) return "bullet";
  if (seconds < 600) return "blitz";
  return "rapid";
}

function recordMatchesFilters(record) {
  const color = $("#filterColor")?.value || "";
  const result = $("#filterResult")?.value || "";
  const time = $("#filterTimeControl")?.value || "";
  const from = $("#filterDateFrom")?.value.replaceAll("-", ".") || "";
  const to = $("#filterDateTo")?.value.replaceAll("-", ".") || "";
  const min = Number($("#filterRatingMin")?.value) || 0;
  const max = Number($("#filterRatingMax")?.value) || Infinity;
  const opponentRating = Number(record.userColor === "w" ? record.headers.BlackElo : record.headers.WhiteElo) || 0;
  const date = record.headers.UTCDate || record.headers.Date || "";
  return (!color || record.userColor === color) &&
    (!result || record.result === result) &&
    (!time || timeControlCategory(record.headers.TimeControl) === time) &&
    (!from || date >= from) && (!to || date <= to) &&
    (!min || opponentRating >= min) && (max === Infinity || opponentRating <= max);
}

function buildIndex() {
  app.positionIndex.clear();
  for (const record of app.archive) {
    if (!recordMatchesFilters(record)) continue;
    const replay = new Chess();
    for (const move of record.moves) {
      const key = positionKey(replay.fen());
      const side = replay.turn();
      if (!record.userColor || record.userColor === side) {
        if (!app.positionIndex.has(key)) app.positionIndex.set(key, []);
        app.positionIndex.get(key).push({ move: move.san, result: record.result, game: record });
      }
      try { replay.move(move); } catch { break; }
    }
  }
  renderHistorical();
}

async function loadLocalArchive() {
  setDataState("loading", "Loading local deepsloth archive…");
  const cached = localStorage.getItem("chessExplorer.archive.deepsloth");
  if (cached) {
    try {
      const records = JSON.parse(cached);
      if (Array.isArray(records) && records.length) {
        app.archive = records;
        app.username = "deepsloth";
        buildIndex();
        setDataState("ready", `${records.length.toLocaleString()} cached games · deepsloth`);
        return;
      }
    } catch { localStorage.removeItem("chessExplorer.archive.deepsloth"); }
  }
  const urls = [];
  for (let year = 2020; year <= 2026; year++) {
    const first = year === 2020 ? 6 : 1;
    const last = year === 2026 ? 6 : 12;
    for (let month = first; month <= last; month++) {
      urls.push(`chess games/ChessCom_deepsloth_${year}${String(month).padStart(2,"0")}.pgn`);
    }
  }
  const all = [];
  let loaded = 0;
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      all.push(...parseArchive(await response.text(), "deepsloth", "local"));
    } catch (error) {
      console.warn("Local archive unavailable", url, error);
      break;
    }
    loaded++;
    setDataState("loading", `Parsing local archive · ${loaded}/${urls.length} months`);
    if (loaded % 5 === 0) await new Promise(requestAnimationFrame);
  }
  app.archive = all;
  buildIndex();
  if (all.length) {
    try { localStorage.setItem("chessExplorer.archive.deepsloth", JSON.stringify(all)); }
    catch { console.info("Archive is too large for localStorage; kept in memory."); }
    setDataState("ready", `${all.length.toLocaleString()} local games · deepsloth`);
  } else {
    setDataState("error", "Serve this folder to load local PGNs");
    $("#importMessage").textContent = "Local files are available, but browsers require an HTTP server. Run: python3 -m http.server 8080";
  }
}

function setDataState(state, text) {
  $("#dataDot").className = `status-dot ${state === "loading" ? "" : state}`;
  $("#dataStatus").textContent = text;
}

function boardSquares() {
  const files = app.flipped ? "hgfedcba" : "abcdefgh";
  const ranks = app.flipped ? "12345678" : "87654321";
  return ranks.split("").flatMap(rank => files.split("").map(file => file + rank));
}

function renderBoard() {
  const board = $("#board");
  board.innerHTML = "";
  const legalTargets = app.selected ? app.chess.moves({ square:app.selected, verbose:true }) : [];
  for (const squareName of boardSquares()) {
    const file = squareName.charCodeAt(0) - 97;
    const rank = Number(squareName[1]);
    const square = document.createElement("div");
    square.className = `square ${(file + rank) % 2 ? "light" : "dark"}`;
    square.dataset.square = squareName;
    const piece = app.chess.get(squareName);
    if (piece) {
      square.classList.add("has-piece");
      const node = document.createElement("span");
      node.className = `piece ${piece.color === "w" ? "white-piece" : "black-piece"}`;
      node.textContent = PIECES[piece.color + piece.type];
      node.draggable = true;
      node.addEventListener("dragstart", e => {
        app.selected = squareName;
        e.dataTransfer.setData("text/plain", squareName);
        setTimeout(renderBoard);
      });
      square.append(node);
    }
    if (squareName === app.selected) square.classList.add("selected");
    if (app.lastMove && (squareName === app.lastMove.from || squareName === app.lastMove.to)) square.classList.add("last");
    if (legalTargets.some(m => m.to === squareName)) square.classList.add("legal");
    const files = app.flipped ? "hgfedcba" : "abcdefgh";
    const ranks = app.flipped ? "12345678" : "87654321";
    if (squareName[1] === ranks[7]) square.insertAdjacentHTML("beforeend", `<span class="coord file">${squareName[0]}</span>`);
    if (squareName[0] === files[0]) square.insertAdjacentHTML("beforeend", `<span class="coord rank">${squareName[1]}</span>`);
    square.addEventListener("click", () => clickSquare(squareName));
    square.addEventListener("dragover", e => e.preventDefault());
    square.addEventListener("drop", e => {
      e.preventDefault();
      attemptMove(e.dataTransfer.getData("text/plain") || app.selected, squareName);
    });
    board.append(square);
  }
  updatePlayerStrips();
}

function clickSquare(square) {
  if (app.selected) {
    if (app.selected === square) { app.selected = null; renderBoard(); return; }
    const possible = app.chess.moves({ square:app.selected, verbose:true }).some(m => m.to === square);
    if (possible) { attemptMove(app.selected, square); return; }
  }
  const piece = app.chess.get(square);
  app.selected = piece && piece.color === app.chess.turn() ? square : null;
  renderBoard();
}

function attemptMove(from, to) {
  if (!from) return;
  const candidates = app.chess.moves({ square:from, verbose:true }).filter(m => m.to === to);
  if (!candidates.length) { app.selected = null; renderBoard(); return; }
  if (candidates.some(m => m.promotion)) {
    showPromotion(from, to, app.chess.turn());
    return;
  }
  makeMove({ from, to });
}

function showPromotion(from, to, color) {
  const picker = $("#promotionPicker");
  picker.innerHTML = "";
  for (const type of ["q","r","b","n"]) {
    const button = document.createElement("button");
    button.textContent = PIECES[color + type];
    button.onclick = () => { picker.classList.add("hidden"); makeMove({ from, to, promotion:type }); };
    picker.append(button);
  }
  picker.classList.remove("hidden");
}

function makeMove(move) {
  try {
    if (app.cursor < app.timeline.length) {
      app.timeline.length = app.cursor;
      for (const ply of app.evalByPly.keys()) if (ply > app.cursor) app.evalByPly.delete(ply);
      for (const ply of app.bestMoveByPly.keys()) if (ply > app.cursor) app.bestMoveByPly.delete(ply);
    }
    const made = app.chess.move(move);
    if (!made) return;
    app.timeline.push({ from:made.from, to:made.to, promotion:made.promotion || null, san:made.san });
    app.cursor = app.timeline.length;
    app.lastMove = made;
    app.selected = null;
    updateAll();
    scheduleAnalysis();
  } catch { toast("That move is not legal"); }
}

function updateAll() {
  renderBoard();
  renderPosition();
  renderMoveHistory();
  renderHistorical();
}

function navigateTo(ply) {
  const target = Math.max(0, Math.min(app.timeline.length, ply));
  const replay = new Chess();
  let last = null;
  for (let i = 0; i < target; i++) last = replay.move(app.timeline[i]);
  app.chess = replay;
  app.cursor = target;
  app.lastMove = last;
  app.selected = null;
  updateAll();
  scheduleAnalysis();
}

function updatePlayerStrips() {
  const topColor = app.flipped ? "White" : "Black";
  const bottomColor = app.flipped ? "Black" : "White";
  $("#topPlayer").textContent = topColor;
  $("#bottomPlayer").textContent = bottomColor;
  const turn = app.chess.turn() === "w" ? "White" : "Black";
  $("#turnBadgeTop").classList.toggle("visible", turn === topColor);
  $("#turnBadgeBottom").classList.toggle("visible", turn === bottomColor);
}

function renderPosition() {
  const history = app.chess.history();
  $("#fenText").textContent = app.chess.fen();
  const opening = openingName();
  $("#positionTitle").textContent = opening || (!history.length ? "Starting position" :
    app.chess.isCheckmate() ? "Checkmate" : app.chess.inCheck() ? `${app.chess.turn() === "w" ? "White" : "Black"} is in check` :
    `${app.chess.turn() === "w" ? "White" : "Black"} to move · ply ${history.length + 1}`);
  $("#undoBtn").disabled = app.cursor === 0;
  $("#firstMoveBtn").disabled = $("#previousMoveBtn").disabled = app.cursor === 0;
  $("#nextMoveBtn").disabled = $("#lastMoveBtn").disabled = app.cursor === app.timeline.length;
  $("#positionCounter").textContent = `${app.cursor} / ${app.timeline.length}`;
}

function renderMoveHistory() {
  const moves = app.timeline;
  const container = $("#moveHistory");
  container.innerHTML = "";
  const moveHtml = (move, ply) => {
    if (!move) return "";
    const badge = move.classification ? `<span class="move-badge badge-${move.classification.toLowerCase()}">${move.classification}</span>` : "";
    return `<div class="move-san ${app.cursor === ply ? "current" : ""}" data-ply="${ply}">${move.san}${badge}</div>`;
  };
  for (let i = 0; i < moves.length; i += 2) {
    container.insertAdjacentHTML("beforeend", `<div class="move-number">${i/2 + 1}.</div>${moveHtml(moves[i], i + 1)}${moveHtml(moves[i+1], i + 2) || "<div></div>"}`);
  }
  container.querySelectorAll("[data-ply]").forEach(node => node.onclick = () => navigateTo(Number(node.dataset.ply)));
  if (!moves.length) container.innerHTML = '<div class="empty" style="grid-column:1/-1"><strong>No moves yet</strong><p>Play on the board or import a PGN.</p></div>';
  $("#moveCountBadge").textContent = moves.length;
  $("#gameResult").textContent = app.chess.isCheckmate() ? (app.chess.turn() === "w" ? "0–1 · Black wins" : "1–0 · White wins") :
    app.chess.isDraw() ? "½–½ · Draw" : "";
}

function renderHistorical() {
  const matches = app.positionIndex.get(positionKey(app.chess.fen())) || [];
  const grouped = new Map();
  for (const item of matches) {
    if (!grouped.has(item.move)) grouped.set(item.move, { move:item.move, count:0, win:0, loss:0, draw:0, unknown:0, points:0 });
    const row = grouped.get(item.move);
    row.count++;
    row[item.result] = (row[item.result] || 0) + 1;
    row.points += item.result === "win" ? 1 : item.result === "draw" ? .5 : 0;
  }
  const rows = [...grouped.values()].sort((a,b) => b.count - a.count);
  $("#matchCount").textContent = `${matches.length.toLocaleString()} game${matches.length === 1 ? "" : "s"}`;
  $("#historicalEmpty").classList.toggle("hidden", rows.length > 0);
  $("#historicalMoves").classList.toggle("hidden", !rows.length);
  $("#historicalMoves").innerHTML = rows.slice(0, 12).map(row => {
    const pct = matches.length ? row.count / matches.length * 100 : 0;
    const known = row.win + row.loss + row.draw || 1;
    const scorePct = row.points / known * 100;
    const winPct = row.win / known * 100;
    return `<div class="history-row">
      <span class="move-chip">${row.move}</span>
      <div class="move-data"><strong>${row.count} game${row.count === 1 ? "" : "s"}</strong>
        <small>${row.win}W · ${row.draw}D · ${row.loss}L · ${winPct.toFixed(0)}% wins · ${scorePct.toFixed(0)}% score</small>
        <div class="result-bar"><span style="width:${row.win/known*100}%"></span><span style="width:${row.draw/known*100}%"></span><span style="width:${row.loss/known*100}%"></span></div>
      </div><span class="prob">${pct.toFixed(pct < 10 ? 1 : 0)}%</span>
    </div>`;
  }).join("");
}

function initEngine() {
  try {
    // Keep the JS and WASM basenames identical. Stockfish derives its WASM URL
    // from the worker URL; browser workers do not reliably retain URL hashes.
    const workerUrl = new URL("./stockfish-18-lite-single.js", document.baseURI);
    workerUrl.searchParams.set("v", "18.0.0");
    app.engine = new Worker(workerUrl);
    $("#analyzeBtn").disabled = true;
    $("#engineState").innerHTML = '<span class="engine-icon">♜</span><div><strong>Starting Stockfish…</strong><p>Loading the local browser engine.</p></div>';
    app.engine.onmessage = event => {
      const line = typeof event.data === "string" ? event.data : "";
      if (event.data?.type === "engine-error") return engineUnavailable(event.data.message);
      if (line === "uciok") { app.engine.postMessage("isready"); return; }
      if (line === "readyok") {
        clearTimeout(app.engineStartupTimer);
        app.engineReady = true;
        $("#analyzeBtn").disabled = false;
        $("#engineState").innerHTML = '<span class="engine-icon">♜</span><div><strong>Engine ready</strong><p>Press Analyze position for the top three lines.</p></div>';
        app.enginePendingAnalysis = false;
        analyze();
        return;
      }
      parseEngineLine(line);
    };
    app.engine.onerror = event => {
      console.error("Stockfish worker error", event);
      engineUnavailable(event.message || "Stockfish worker could not start.");
    };
    app.engine.postMessage("uci");
    app.engineStartupTimer = setTimeout(() => {
      if (!app.engineReady) engineUnavailable("Stockfish did not respond within 30 seconds.");
    }, 30000);
  } catch (error) {
    console.error("Could not create Stockfish worker", error);
    engineUnavailable(error.message || "Web Workers are unavailable.");
  }
}

function engineUnavailable(message) {
  clearTimeout(app.engineStartupTimer);
  app.engineReady = false;
  $("#analyzeBtn").disabled = false;
  $("#engineState").innerHTML = `<span class="engine-icon">!</span><div><strong>Engine unavailable</strong><p>${message} Reload the page and make sure it is opened through ./start.sh, not as a file.</p></div>`;
}

function analyze() {
  if (!app.engine) {
    engineUnavailable("The Stockfish worker was not created.");
    return;
  }
  if (!app.engineReady) {
    app.enginePendingAnalysis = true;
    $("#engineState").innerHTML = '<span class="engine-icon">♜</span><div><strong>Starting Stockfish…</strong><p>Analysis will begin as soon as the engine is ready.</p></div>';
    return;
  }
  app.engineLines.clear();
  updateEvaluationBar("0.00", true);
  $("#engineLines").classList.add("hidden");
  $("#engineState").classList.remove("hidden");
  $("#engineState").innerHTML = '<span class="engine-icon">♜</span><div><strong>Stockfish is thinking…</strong><p>Searching the current position.</p></div>';
  $("#engineEval").textContent = "…";
  $("#boardArrows").innerHTML = "";
  app.engine.postMessage("stop");
  app.engine.postMessage(`setoption name MultiPV value ${app.engineMultiPv}`);
  app.engine.postMessage(`setoption name Skill Level value ${app.engineStrength}`);
  app.engine.postMessage(`position fen ${app.chess.fen()}`);
  app.engine.postMessage(app.engineInfinite ? "go infinite" :
    app.engineTime ? `go movetime ${app.engineTime}` : `go depth ${app.engineDepth}`);
}

function parseEngineLine(line) {
  if (!line.startsWith("info") || !line.includes(" pv ")) return;
  const depth = Number(line.match(/\bdepth (\d+)/)?.[1] || 0);
  const multipv = Number(line.match(/\bmultipv (\d+)/)?.[1] || 1);
  const cp = line.match(/\bscore cp (-?\d+)/);
  const mate = line.match(/\bscore mate (-?\d+)/);
  const uciPv = line.split(" pv ")[1]?.trim().split(/\s+/).slice(0, 10) || [];
  const sideFactor = app.chess.turn() === "w" ? 1 : -1;
  const score = mate ? `M${Number(mate[1]) * sideFactor}` : cp ? `${(Number(cp[1]) / 100 * sideFactor).toFixed(2)}` : "—";
  if (depth < (app.engineLines.get(multipv)?.depth || 0)) return;
  app.engineLines.set(multipv, { depth, score, pv: uciToSan(uciPv), bestMove:uciPv[0] });
  renderEngineLines();
}

function uciToSan(moves) {
  const temp = new Chess(app.chess.fen());
  const san = [];
  for (const uci of moves) {
    try {
      const move = temp.move({ from:uci.slice(0,2), to:uci.slice(2,4), promotion:uci[4] });
      if (!move) break;
      san.push(move.san);
    } catch { break; }
  }
  return san.join(" ");
}

function renderEngineLines() {
  const rows = [...app.engineLines.entries()].sort((a,b) => a[0]-b[0]);
  if (!rows.length) return;
  $("#engineState").classList.add("hidden");
  $("#engineLines").classList.remove("hidden");
  $("#engineEval").textContent = rows[0][1].score;
  updateEvaluationBar(rows[0][1].score);
  const currentEval = numericEvaluation(rows[0][1].score);
  if (currentEval != null) app.evalByPly.set(app.cursor, currentEval);
  if (rows[0][1].bestMove) app.bestMoveByPly.set(app.cursor, rows[0][1].bestMove);
  classifyTimeline();
  renderMoveHistory();
  renderBestMoveArrows(rows);
  $("#engineLines").innerHTML = rows.map(([rank, row]) =>
    `<div class="engine-line"><span class="engine-rank">#${rank}</span><span class="engine-score">${row.score}</span><span class="engine-pv" title="${row.pv}">${row.pv}</span></div>`
  ).join("");
}

function squareCenter(square) {
  let file = square.charCodeAt(0) - 97;
  let rank = 8 - Number(square[1]);
  if (app.flipped) { file = 7 - file; rank = 7 - rank; }
  return { x:file * 100 + 50, y:rank * 100 + 50 };
}

function renderBestMoveArrows(rows = [...app.engineLines.entries()].sort((a,b) => a[0] - b[0])) {
  const svg = $("#boardArrows");
  const colors = ["#8bc34acc", "#42a5f5bb", "#ffab40bb", "#ab47bcaa", "#ef5350aa"];
  const defs = colors.map((color, i) => `<marker id="arrow-${i}" markerWidth="5" markerHeight="5" refX="3.5" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="${color}"/></marker>`).join("");
  const arrows = rows.map(([rank, row], i) => {
    if (!row.bestMove) return "";
    const from = squareCenter(row.bestMove.slice(0,2));
    const to = squareCenter(row.bestMove.slice(2,4));
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const endX = to.x - dx / length * 25, endY = to.y - dy / length * 25;
    return `<line x1="${from.x}" y1="${from.y}" x2="${endX}" y2="${endY}" stroke="${colors[i]}" stroke-width="${rank === 1 ? 18 : 11}" stroke-linecap="round" marker-end="url(#arrow-${i})"/>`;
  }).join("");
  svg.innerHTML = `<defs>${defs}</defs>${arrows}`;
}

function updateEvaluationBar(score, loading = false) {
  let whitePercent = 50;
  let label = loading ? "…" : score;
  if (!loading && typeof score === "string" && score.startsWith("M")) {
    const mate = Number(score.slice(1));
    whitePercent = mate >= 0 ? 100 : 0;
    label = mate >= 0 ? `M${Math.abs(mate)}` : `-M${Math.abs(mate)}`;
  } else if (!loading) {
    const pawns = Number(score);
    if (Number.isFinite(pawns)) {
      // Smoothly maps evaluations to the bar without letting ordinary
      // advantages instantly consume the entire display.
      whitePercent = 50 + 50 * (2 / (1 + Math.exp(-0.55 * pawns)) - 1);
      whitePercent = Math.max(3, Math.min(97, whitePercent));
      label = pawns > 0 ? `+${pawns.toFixed(1)}` : pawns.toFixed(1);
    }
  }
  $("#evalWhite").style.height = `${whitePercent}%`;
  $("#evalBarLabel").textContent = label;
  $("#evalBar").classList.toggle("black-favored", whitePercent < 42);
}

function scheduleAnalysis() {
  clearTimeout(app.engineTimer);
  if (app.engineReady) app.engineTimer = setTimeout(analyze, 450);
}

async function fetchChessComGames() {
  const username = $("#usernameInput").value.trim().toLowerCase();
  if (!username || !/^[a-z0-9_-]{2,25}$/i.test(username)) {
    $("#importMessage").textContent = "Enter a valid Chess.com username.";
    return;
  }
  const button = $("#fetchGamesBtn");
  button.disabled = true;
  $("#fetchProgress").classList.remove("hidden");
  $("#importMessage").textContent = "Finding monthly archives…";
  try {
    const archiveRes = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`);
    if (archiveRes.status === 404) throw new Error("That Chess.com username was not found.");
    if (!archiveRes.ok) throw new Error(`Chess.com returned HTTP ${archiveRes.status}.`);
    const { archives = [] } = await archiveRes.json();
    if (!archives.length) throw new Error("No public games were found for this player.");
    const records = [];
    for (let i = 0; i < archives.length; i++) {
      $("#importMessage").textContent = `Downloading archive ${i + 1} of ${archives.length}…`;
      $("#progressBar").style.width = `${(i / archives.length) * 100}%`;
      const response = await fetch(`${archives[i]}/pgn`);
      if (response.ok) records.push(...parseArchive(await response.text(), username, "chess.com"));
    }
    app.archive = records;
    app.username = username;
    buildIndex();
    localStorage.setItem("chessExplorer.username", username);
    try { localStorage.setItem(`chessExplorer.archive.${username}`, JSON.stringify(records)); }
    catch { /* Indexed data remains available for this session. */ }
    setDataState("ready", `${records.length.toLocaleString()} games · ${username}`);
    $("#progressBar").style.width = "100%";
    $("#importMessage").textContent = `Loaded ${records.length.toLocaleString()} games for ${username}.`;
    showTab("explorer");
  } catch (error) {
    $("#importMessage").textContent = error.message.includes("Failed to fetch") ?
      "Could not reach Chess.com. Check your connection or browser privacy settings." : error.message;
  } finally {
    button.disabled = false;
    setTimeout(() => $("#fetchProgress").classList.add("hidden"), 800);
  }
}

function loadPgnOnBoard() {
  const text = $("#pgnInput").value.trim();
  if (!text) return toast("Paste or choose a PGN first");
  try {
    const game = new Chess();
    game.loadPgn(splitPgnGames(text)[0], { strict:false });
    app.chess = game;
    app.timeline = game.history({ verbose:true }).map(move => ({
      from:move.from, to:move.to, promotion:move.promotion || null, san:move.san
    }));
    app.cursor = app.timeline.length;
    app.lastMove = app.timeline.at(-1) || null;
    app.evalByPly.clear();
    app.bestMoveByPly.clear();
    app.selected = null;
    updateAll();
    showTab("explorer");
    scheduleAnalysis();
    toast("PGN loaded");
  } catch { toast("That PGN could not be parsed"); }
}

function addPgnToArchive() {
  const records = parseArchive($("#pgnInput").value, app.username || "unknown", "manual");
  if (!records.length) return toast("No valid games found");
  app.archive.push(...records);
  buildIndex();
  setDataState("ready", `${app.archive.length.toLocaleString()} games · session archive`);
  toast(`Added ${records.length} game${records.length === 1 ? "" : "s"}`);
}

function persistSavedPositions() {
  localStorage.setItem("chessExplorer.savedPositions", JSON.stringify(app.savedPositions));
  renderSavedPositions();
}

function saveCurrentPosition() {
  const note = $("#positionNote").value.trim();
  const fen = app.chess.fen();
  const saved = {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    fen,
    note,
    opening: openingName() || "Custom position",
    createdAt: new Date().toISOString(),
    moves: app.timeline.slice(0, app.cursor).map(({ from, to, promotion, san }) => ({ from, to, promotion, san }))
  };
  app.savedPositions.unshift(saved);
  persistSavedPositions();
  $("#positionNote").value = "";
  $("#savePositionForm").classList.add("hidden");
  toast("Position saved");
}

function restoreSavedPosition(id) {
  const saved = app.savedPositions.find(position => position.id === id);
  if (!saved) return;
  try {
    if (saved.moves?.length) {
      const replay = new Chess();
      const timeline = [];
      for (const stored of saved.moves) {
        const move = replay.move(stored);
        timeline.push({ from:move.from, to:move.to, promotion:move.promotion || null, san:move.san });
      }
      app.chess = replay;
      app.timeline = timeline;
      app.cursor = timeline.length;
      app.lastMove = timeline.at(-1) || null;
    } else {
      app.chess = new Chess(saved.fen);
      app.timeline = [];
      app.cursor = 0;
      app.lastMove = null;
    }
    app.evalByPly.clear();
    app.bestMoveByPly.clear();
    app.selected = null;
    updateAll();
    scheduleAnalysis();
    toast("Saved position restored");
  } catch {
    toast("This saved position could not be restored");
  }
}

function renderSavedPositions() {
  $("#savedCount").textContent = app.savedPositions.length;
  const container = $("#savedPositions");
  if (!app.savedPositions.length) {
    container.innerHTML = '<div class="saved-empty">Press ☆ beside the FEN to bookmark a position.</div>';
    return;
  }
  container.innerHTML = app.savedPositions.map(saved => `
    <div class="saved-row">
      <div><strong>${escapeHtml(saved.opening)}</strong>
        <small>${escapeHtml(saved.note || "No note")} · ${new Date(saved.createdAt).toLocaleDateString()}</small>
      </div>
      <div class="saved-actions">
        <button data-load-save="${escapeHtml(saved.id)}">Load</button>
        <button class="delete-save" data-delete-save="${escapeHtml(saved.id)}">Delete</button>
      </div>
    </div>`).join("");
  container.querySelectorAll("[data-load-save]").forEach(button => button.onclick = () => restoreSavedPosition(button.dataset.loadSave));
  container.querySelectorAll("[data-delete-save]").forEach(button => button.onclick = () => {
    app.savedPositions = app.savedPositions.filter(position => position.id !== button.dataset.deleteSave);
    persistSavedPositions();
  });
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-page").forEach(p => p.classList.toggle("active", p.id === `${name}Tab`));
}

document.querySelectorAll(".tab").forEach(tab => tab.onclick = () => showTab(tab.dataset.tab));
$("#resetBtn").onclick = () => { app.chess.reset(); app.timeline = []; app.cursor = 0; app.evalByPly.clear(); app.bestMoveByPly.clear(); app.lastMove = null; app.selected = null; updateAll(); scheduleAnalysis(); };
$("#undoBtn").onclick = () => navigateTo(app.cursor - 1);
$("#firstMoveBtn").onclick = () => navigateTo(0);
$("#previousMoveBtn").onclick = () => navigateTo(app.cursor - 1);
$("#nextMoveBtn").onclick = () => navigateTo(app.cursor + 1);
$("#lastMoveBtn").onclick = () => navigateTo(app.timeline.length);
$("#flipBtn").onclick = () => { app.flipped = !app.flipped; renderBoard(); renderBestMoveArrows(); };
$("#analyzeBtn").onclick = analyze;
$("#depthSelect").value = String(app.engineDepth);
$("#depthSelect").onchange = event => {
  app.engineDepth = Math.min(22, Math.max(8, Number(event.target.value) || 16));
  localStorage.setItem("chessExplorer.engineDepth", String(app.engineDepth));
  analyze();
};
$("#engineTime").value = String(app.engineTime);
$("#engineMultiPv").value = String(app.engineMultiPv);
$("#engineStrength").value = String(app.engineStrength);
$("#engineTime").onchange = event => {
  app.engineTime = Number(event.target.value);
  localStorage.setItem("chessExplorer.engineTime", String(app.engineTime));
  analyze();
};
$("#engineMultiPv").onchange = event => {
  app.engineMultiPv = Number(event.target.value);
  localStorage.setItem("chessExplorer.engineMultiPv", String(app.engineMultiPv));
  analyze();
};
$("#engineStrength").onchange = event => {
  app.engineStrength = Number(event.target.value);
  localStorage.setItem("chessExplorer.engineStrength", String(app.engineStrength));
  analyze();
};
$("#engineInfinite").onchange = event => {
  app.engineInfinite = event.target.checked;
  analyze();
};
const filterIds = ["filterTimeControl","filterColor","filterResult","filterDateFrom","filterDateTo","filterRatingMin","filterRatingMax"];
let filterTimer;
filterIds.forEach(id => {
  $(`#${id}`).oninput = () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(buildIndex, 180);
  };
});
$("#clearFiltersBtn").onclick = () => {
  filterIds.forEach(id => { $(`#${id}`).value = ""; });
  buildIndex();
};
$("#copyFenBtn").onclick = async () => { await navigator.clipboard.writeText(app.chess.fen()); toast("FEN copied"); };
$("#savePositionBtn").onclick = () => {
  $("#savePositionForm").classList.toggle("hidden");
  if (!$("#savePositionForm").classList.contains("hidden")) $("#positionNote").focus();
};
$("#confirmSavePositionBtn").onclick = saveCurrentPosition;
$("#positionNote").onkeydown = event => { if (event.key === "Enter") saveCurrentPosition(); };
$("#fetchGamesBtn").onclick = fetchChessComGames;
$("#loadPgnBtn").onclick = loadPgnOnBoard;
$("#addArchiveBtn").onclick = addPgnToArchive;
$("#pgnFile").onchange = async event => {
  const texts = await Promise.all([...event.target.files].map(file => file.text()));
  $("#pgnInput").value = texts.join("\n\n");
  toast(`${event.target.files.length} file${event.target.files.length === 1 ? "" : "s"} ready`);
};
$("#usernameInput").value = app.username;

updateAll();
renderSavedPositions();
initEngine();
loadLocalArchive();
