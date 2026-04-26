/* ============================================================
   MeTime+ — app.js
   Tagline : Your time. Your flow.
   Author  : Ayushman Thakur
   ============================================================

   SECTIONS
   ─────────────────────────────────────────────────────────
    1.  Data Structures & Global State
    2.  Storage Helpers  (loadFromStorage / saveToStorage)
    3.  Utility Helpers  (uid, escHtml, date helpers …)
    4.  Animated Particles (background SVG)
    5.  Zen Score
    6.  Stats & Progress Bar
    7.  Energy Suggestion Bar
    8.  Task Render Engine  (getFilteredTasks / renderTasks / buildTaskElement)
    9.  Add Task
   10.  Delete / Toggle Task
   11.  Subtasks
   12.  Reflection Loop
   13.  Recurring Tasks
   14.  Task Decay & Archive
   15.  Drag & Drop  (list view)
   16.  Filters, Search, Sort
   17.  Top 3 Commitments
   18.  Pomodoro Timer
   19.  Monk Mode
   20.  Notes Panel
   21.  Eisenhower Matrix View
   22.  Done Wall
   23.  Reflection Weekly Chart  (Canvas)
   24.  Confetti  (Canvas)
   25.  Soundscape  (Web Audio API — no external files)
   26.  Theme Toggle
   27.  Mood Check-in Overlay
   28.  Toast Notifications
   29.  Streak Logic
   30.  Export / Import
   31.  Keyboard Shortcuts
   32.  init()  — event-listener hub
   ============================================================ */

'use strict';

// ============================================================
// 1. DATA STRUCTURES & GLOBAL STATE
// ============================================================

/** Master task list — populated by loadFromStorage() */
let tasks = [];

/** Completed / released archive */
let archive = [];

/** Daily mood records  [{ date, energy, focus, stress }] */
let moods = [];

/** Weekly reflection tallies  { "Mon": { smooth, friction, exhausting }, … } */
let reflections = {};

// ── Soundscape ──────────────────────────────────────────────
let audioCtx     = null;
let soundNodes   = [];           // active AudioNode references
let currentSound = 'off';
let soundVolume  = 0.4;          // 0 – 1

// ── Pomodoro ─────────────────────────────────────────────────
let pomoTaskId   = null;
let pomoInterval = null;
let pomoSeconds  = 25 * 60;
let pomoRunning  = false;
let pomoSessions = 0;            // sessions completed today
const POMO_TOTAL = 25 * 60;      // 1500 s

// ── UI state ─────────────────────────────────────────────────
let dragSrcId      = null;
let activeFilter   = 'all';
let activeWorkspace= 'all';
let activeSearch   = '';
let activeSortBy   = 'date-added';
let matrixOpen     = false;
let monkTaskId     = null;
let noteTaskId     = null;
let decayTaskId    = null;
let top3Locked     = false;
let importFileData = null;
let waveAnimId     = null;

// ============================================================
// 2. STORAGE HELPERS
// ============================================================

function loadFromStorage() {
  try {
    tasks        = JSON.parse(localStorage.getItem('mt-tasks')       || '[]');
    archive      = JSON.parse(localStorage.getItem('mt-archive')     || '[]');
    moods        = JSON.parse(localStorage.getItem('mt-moods')       || '[]');
    reflections  = JSON.parse(localStorage.getItem('mt-reflections') || '{}');
    pomoSessions = parseInt(localStorage.getItem('mt-pomo-today')    || '0', 10);
    currentSound = localStorage.getItem('mt-sound') || 'off';
    soundVolume  = parseFloat(localStorage.getItem('mt-vol')         || '0.4');
    top3Locked   = localStorage.getItem('mt-top3locked') === 'true';

    const today = todayStr();

    // Reset Top-3 lock at midnight
    if (localStorage.getItem('mt-top3date') !== today) {
      top3Locked = false;
      tasks.forEach(t => { t.isCommitment = false; });
      localStorage.setItem('mt-top3locked', 'false');
      localStorage.setItem('mt-top3date', today);
    }

    // Reset daily pomo count
    if (localStorage.getItem('mt-pomo-date') !== today) {
      pomoSessions = 0;
      localStorage.setItem('mt-pomo-today', '0');
      localStorage.setItem('mt-pomo-date', today);
    }
  } catch (e) {
    console.warn('MeTime+: storage read error', e);
    tasks = []; archive = []; moods = []; reflections = {};
  }
}

function saveToStorage() {
  try {
    localStorage.setItem('mt-tasks',       JSON.stringify(tasks));
    localStorage.setItem('mt-archive',     JSON.stringify(archive));
    localStorage.setItem('mt-moods',       JSON.stringify(moods));
    localStorage.setItem('mt-reflections', JSON.stringify(reflections));
    localStorage.setItem('mt-pomo-today',  String(pomoSessions));
  } catch (e) {
    console.warn('MeTime+: storage write error', e);
  }
}

// ============================================================
// 3. UTILITY HELPERS
// ============================================================

/** Generates a short unique id */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Escape HTML to prevent XSS */
function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Returns today's date as a locale string — used as localStorage key */
function todayStr() {
  return new Date().toDateString();
}

/** Checks if an ISO string is today */
function isToday(iso) {
  if (!iso) return false;
  return new Date(iso).toDateString() === todayStr();
}

/** True when a task is past its due date and not yet completed */
function isOverdue(task) {
  if (!task.dueAt || task.completedAt) return false;
  return new Date(task.dueAt) < new Date();
}

/** True when a task hasn't been touched for 14+ days */
function isDecayed(task) {
  if (!task.lastTouchedAt || task.completedAt) return false;
  return (Date.now() - new Date(task.lastTouchedAt)) / 86400000 >= 14;
}

/** Returns a human-readable due-date label + CSS class */
function formatDueDate(dueAt) {
  if (!dueAt) return null;
  const d    = new Date(dueAt);
  const now  = new Date(); now.setHours(0, 0, 0, 0);
  const day  = new Date(dueAt); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - now) / 86400000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let label, cls = '';
  if      (diff === 0)  { label = `Today ${time}`;     cls = 'today';   }
  else if (diff === 1)  { label = `Tomorrow ${time}`;                   }
  else if (diff === -1) { label = `Yesterday ${time}`;  cls = 'overdue'; }
  else if (diff < 0)   { label = `${d.toLocaleDateString()} ${time}`;  cls = 'overdue'; }
  else                  { label = `${d.toLocaleDateString()} ${time}`;                  }
  return { label, cls };
}

/** Returns 'morning' | 'afternoon' | 'evening' | 'night' */
function getTimeOfDay() {
  const h = new Date().getHours();
  if (h >= 6  && h < 12) return 'morning';
  if (h >= 12 && h < 16) return 'afternoon';
  if (h >= 16 && h < 20) return 'evening';
  return 'night';
}

/** Energy level suggested for the current time of day */
function suggestedEnergy() {
  const tod = getTimeOfDay();
  if (tod === 'morning')   return 'high';
  if (tod === 'afternoon') return 'medium';
  return 'low';
}

/** Open a modal by id */
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}

/** Close a modal by id — exposed on window for inline onclick */
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}
window.closeModal = closeModal;

// ============================================================
// 4. ANIMATED PARTICLES
// ============================================================

function buildParticles() {
  const svg    = document.getElementById('particle-svg');
  if (!svg) return;
  const colors = ['#7c6fea', '#4fd6c8', '#f97171', '#f4c66a'];

  for (let i = 0; i < 32; i++) {
    const x   = (Math.random() * 100).toFixed(1);
    const y   = (Math.random() * 100).toFixed(1);
    const r   = (1 + Math.random() * 2.2).toFixed(1);
    const dur = (9 + Math.random() * 18).toFixed(1);
    const dy  = -(35 + Math.random() * 65);
    const dx  = -20 + Math.random() * 40;
    const col = colors[Math.floor(Math.random() * colors.length)];
    const op  = (0.08 + Math.random() * 0.22).toFixed(2);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', `${x}%`);
    circle.setAttribute('cy', `${y}%`);
    circle.setAttribute('r',  r);
    circle.setAttribute('fill', col);
    circle.setAttribute('opacity', op);

    const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
    anim.setAttribute('dur',         `${dur}s`);
    anim.setAttribute('repeatCount', 'indefinite');
    anim.setAttribute('path',        `M0,0 C${dx/2},${dy/3} ${dx},${dy*0.7} ${dx},${dy}`);
    anim.setAttribute('calcMode',    'spline');
    anim.setAttribute('keySplines',  '0.4 0 0.2 1');

    circle.appendChild(anim);
    svg.appendChild(circle);
  }
}

// ============================================================
// 5. ZEN SCORE
// ============================================================

function calcZenScore() {
  const active       = tasks.filter(t => !t.isArchived);
  const total        = Math.max(active.length, 1);
  const doneToday    = active.filter(t => t.completedAt && isToday(t.completedAt)).length;
  const overdueCount = active.filter(t => isOverdue(t)).length;
  const streak       = getStreak();

  let score = 50;
  score += (doneToday / total) * 20;
  score += Math.min(pomoSessions * 5, 15);
  score += (streak > 2 ? 10 : 0);
  score -= overdueCount * 3;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function zenScoreMessage(score) {
  if (score <= 30) return 'Take a breath and start small 🌱';
  if (score <= 50) return 'Building momentum… 💫';
  if (score <= 70) return 'Making good progress 🚀';
  if (score <= 89) return "You're in flow ✨";
  return 'Peak state — unstoppable 🔥';
}

function updateZenScore() {
  const score  = calcZenScore();
  const valEl  = document.getElementById('zen-score-value');
  const msgEl  = document.getElementById('zen-score-msg');
  if (valEl) valEl.textContent = score;
  if (msgEl) msgEl.textContent = zenScoreMessage(score);
}

// ============================================================
// 6. STATS & PROGRESS BAR
// ============================================================

function updateStats() {
  const active   = tasks.filter(t => !t.isArchived);
  const total    = active.length;
  const done     = active.filter(t => !!t.completedAt).length;
  const overdue  = active.filter(t => isOverdue(t)).length;
  const streak   = getStreak();
  const pct      = total > 0 ? Math.round((done / total) * 100) : 0;
  const fadedCnt = active.filter(t => !t.completedAt && isDecayed(t)).length;

  document.getElementById('stat-total').textContent   = total;
  document.getElementById('stat-done').textContent    = done;
  document.getElementById('stat-overdue').textContent = overdue;
  document.getElementById('stat-streak').textContent  = streak;
  document.getElementById('progress-pct').textContent = `${pct}%`;

  const fillEl = document.getElementById('progress-fill');
  fillEl.style.width = `${pct}%`;
  fillEl.closest('[role="progressbar"]')?.setAttribute('aria-valuenow', pct);

  // Faded-tasks filter badge
  const fadedBtn  = document.getElementById('faded-filter-btn');
  const fadedSpan = document.getElementById('faded-count');
  fadedBtn.hidden = fadedCnt === 0;
  if (fadedSpan) fadedSpan.textContent = fadedCnt;

  updateZenScore();
  updateEnergySuggestion();
  updateTop3Bar();
  drawReflectionChart();
}

// ============================================================
// 7. ENERGY SUGGESTION BAR
// ============================================================

function updateEnergySuggestion() {
  const bar = document.getElementById('energy-suggestion');
  if (!bar) return;
  const tod    = getTimeOfDay();
  const energy = suggestedEnergy();
  const labels = { high: 'High Energy ⚡⚡', medium: 'Medium Energy ⚡', low: 'Low Energy 🌙' };
  bar.textContent = `It's ${tod}. Suggested for now: ${labels[energy]} tasks`;
}

// ============================================================
// 8. TASK RENDER ENGINE
// ============================================================

function getFilteredTasks() {
  let list = tasks.filter(t => !t.isArchived);

  // Workspace
  if (activeWorkspace !== 'all') {
    list = list.filter(t => t.workspace === activeWorkspace);
  }

  // Text / tag search
  if (activeSearch) {
    const q = activeSearch.toLowerCase();
    list = list.filter(t =>
      t.title.toLowerCase().includes(q) ||
      (t.tag && t.tag.label.toLowerCase().includes(q))
    );
  }

  // Filter tabs
  switch (activeFilter) {
    case 'pending': list = list.filter(t => !t.completedAt);          break;
    case 'done':    list = list.filter(t => !!t.completedAt);         break;
    case 'high':    list = list.filter(t => t.priority === 'high');   break;
    case 'medium':  list = list.filter(t => t.priority === 'medium'); break;
    case 'low':     list = list.filter(t => t.priority === 'low');    break;
    case 'overdue': list = list.filter(t => isOverdue(t));            break;
    case 'faded':   list = list.filter(t => !t.completedAt && isDecayed(t)); break;
  }

  // Sort
  const pOrd = { high: 0, medium: 1, low: 2 };
  switch (activeSortBy) {
    case 'priority':   list.sort((a, b) => pOrd[a.priority] - pOrd[b.priority]);  break;
    case 'alpha':      list.sort((a, b) => a.title.localeCompare(b.title));        break;
    case 'due-date':   list.sort((a, b) => {
      if (!a.dueAt) return 1; if (!b.dueAt) return -1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    }); break;
    default:           list.sort((a, b) => b.order - a.order);                    break;  // date-added
  }

  return list;
}

function renderTasks() {
  if (matrixOpen) { renderMatrix(); return; }

  const container = document.getElementById('task-list');
  const emptyEl   = document.getElementById('empty-state');
  const list      = getFilteredTasks();

  container.innerHTML = '';

  emptyEl.classList.toggle('visible', list.length === 0);

  // Check last mood for peak-focus badge
  const lastMood    = moods[moods.length - 1];
  const isPeakFocus = !!(lastMood && lastMood.focus > 7);
  const energyMatch = suggestedEnergy();

  list.forEach(task => container.appendChild(
    buildTaskElement(task, energyMatch, isPeakFocus)
  ));

  updateStats();
}

function buildTaskElement(task, energyMatch, isPeakFocus) {
  const el = document.createElement('div');
  el.className = [
    'task-item',
    task.priority,
    task.completedAt                          ? 'done'         : '',
    isDecayed(task) && !task.completedAt      ? 'faded'        : '',
    task.isCommitment                         ? 'commitment'   : '',
    task.energyLevel === energyMatch
      && !task.completedAt                    ? 'energy-match' : '',
  ].filter(Boolean).join(' ');

  el.setAttribute('draggable', 'true');
  el.setAttribute('role', 'listitem');
  el.dataset.id = task.id;

  // ── Date badge ──────────────────────────────────────────
  let dateBadgeHtml = '';
  if (task.dueAt) {
    const fd = formatDueDate(task.dueAt);
    dateBadgeHtml = `<span class="task-date-badge ${fd.cls}">📅 ${escHtml(fd.label)}</span>`;
  }

  // ── Tag pill ─────────────────────────────────────────────
  const tagHtml = task.tag
    ? `<span class="task-tag"
          style="background:${task.tag.color}22;color:${task.tag.color};border:1px solid ${task.tag.color}44"
        >${escHtml(task.tag.label)}</span>`
    : '';

  // ── Priority badge ───────────────────────────────────────
  const pIcons = { high: '🔴', medium: '🟡', low: '🟢' };
  const priBadge = `<span class="priority-badge ${task.priority}">${pIcons[task.priority]} ${task.priority}</span>`;

  // ── Energy badge ─────────────────────────────────────────
  const eLabels = { high: '⚡⚡ High', medium: '⚡ Med', low: '🌙 Low' };
  const energyBadge = `<span class="energy-badge">${eLabels[task.energyLevel] || ''}</span>`;

  // ── Workspace badge ──────────────────────────────────────
  const wsIcons = { work: '💼', personal: '🏠', study: '📚' };
  const wsBadge = `<span class="ws-badge">${wsIcons[task.workspace] || ''} ${task.workspace}</span>`;

  // ── Peak-focus badge ─────────────────────────────────────
  const peakBadge = isPeakFocus && task.priority === 'high' && !task.completedAt
    ? `<span class="peak-focus-badge">⭐ Peak Focus</span>` : '';

  // ── Recurring indicators ─────────────────────────────────
  const recurIcon   = task.isRecurring
    ? `<span class="recurring-icon" title="Recurring">↻</span>` : '';
  const recurStreak = task.isRecurring && task.streak > 0
    ? `<span class="recurring-streak-badge">🔥 ${task.streak}</span>` : '';

  // ── Subtask progress ─────────────────────────────────────
  const subs     = task.subtasks || [];
  const subDone  = subs.filter(s => s.done).length;
  const subTotal = subs.length;
  const subPct   = subTotal > 0 ? Math.round((subDone / subTotal) * 100) : 0;
  const subInfo  = subTotal > 0
    ? `<span class="task-date-badge">📋 ${subDone}/${subTotal}</span>` : '';
  const subProgressHtml = subTotal > 0
    ? `<div class="subtask-progress-bar">
         <div class="subtask-progress-fill" style="width:${subPct}%"></div>
       </div>` : '';

  // ── Note snippet ─────────────────────────────────────────
  const noteHtml = task.notes
    ? `<div class="task-note">${escHtml(task.notes.slice(0, 80))}${task.notes.length > 80 ? '…' : ''}</div>`
    : '';

  // ── Star / commitment button ─────────────────────────────
  const starDisabled = top3Locked && !task.isCommitment ? 'star-disabled' : '';
  const starActive   = task.isCommitment ? 'starred' : '';
  const starHtml = !task.completedAt
    ? `<button class="star-btn ${starActive} ${starDisabled}"
              data-star="${task.id}"
              title="${task.isCommitment ? 'Remove from Top 3' : 'Add to Top 3'}"
              aria-label="Toggle Top-3 commitment"
       >${task.isCommitment ? '⭐' : '☆'}</button>` : '';

  // ── Subtask rows HTML ────────────────────────────────────
  const subRowsHtml = subs.map((s, si) => `
    <div class="subtask-row">
      <div class="subtask-check ${s.done ? 'done-sub' : ''}"
           data-task="${task.id}" data-sub="${si}"
           role="checkbox" aria-checked="${s.done}" tabindex="0"
      >${s.done ? '✓' : ''}</div>
      <span class="subtask-text ${s.done ? 'done-sub' : ''}">${escHtml(s.text)}</span>
    </div>`).join('');

  el.innerHTML = `
    <div class="task-top-row">
      <div class="drag-handle" aria-hidden="true">⠿</div>
      <div class="task-check"
           data-id="${task.id}"
           role="checkbox" aria-checked="${!!task.completedAt}" tabindex="0"
      >${task.completedAt ? '✓' : ''}</div>
      <div class="task-body">
        <div class="task-main-text">
          ${recurIcon}${escHtml(task.title)}${recurStreak}
        </div>
        <div class="task-meta">
          ${priBadge}${tagHtml}${dateBadgeHtml}${energyBadge}${wsBadge}${subInfo}${peakBadge}
        </div>
        ${subProgressHtml}
        ${noteHtml}
        ${subTotal > 0
          ? `<button class="subtask-toggle-btn" data-toggle="${task.id}" aria-expanded="false">
               ▶ ${subTotal} subtask${subTotal > 1 ? 's' : ''}
             </button>` : ''}
      </div>
      ${starHtml}
      <div class="task-actions">
        <button class="task-act-btn pomo-act" data-pomo="${task.id}"     title="Pomodoro">🍅</button>
        <button class="task-act-btn"          data-note-open="${task.id}" title="Notes">📝</button>
        <button class="task-act-btn del"      data-del="${task.id}"       title="Delete" aria-label="Delete task">✕</button>
      </div>
    </div>
    <div class="subtask-list" id="subs-${task.id}" hidden>
      ${subRowsHtml}
      <div class="add-subtask-row">
        <input class="subtask-input" type="text"
               id="sub-inp-${task.id}" placeholder="Add subtask…" aria-label="Add subtask"/>
        <button class="subtask-add-btn" data-addsub="${task.id}">+ Sub</button>
      </div>
    </div>`;

  // ── Drag events ──────────────────────────────────────────
  el.addEventListener('dragstart', e => {
    dragSrcId = task.id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend',  () => el.classList.remove('dragging'));
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave',() => el.classList.remove('drag-over'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('drag-over');
    if (dragSrcId && dragSrcId !== task.id) {
      const si = tasks.findIndex(t => t.id === dragSrcId);
      const di = tasks.findIndex(t => t.id === task.id);
      if (si !== -1 && di !== -1) {
        const [moved] = tasks.splice(si, 1);
        tasks.splice(di, 0, moved);
        saveToStorage();
        renderTasks();
      }
    }
  });

  // ── Click / key delegation ───────────────────────────────
  el.addEventListener('click',   handleTaskItemClick);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') handleTaskItemClick(e);
  });

  return el;
}

// ── Central click handler for task card elements ─────────────
function handleTaskItemClick(e) {
  // 1. Completion checkbox
  const checkEl = e.target.closest('.task-check');
  if (checkEl && checkEl.dataset.id) { toggleTask(checkEl.dataset.id); return; }

  // 2. Delete
  const delBtn = e.target.closest('[data-del]');
  if (delBtn) { deleteTask(delBtn.dataset.del); return; }

  // 3. Pomodoro
  const pomoBtn = e.target.closest('[data-pomo]');
  if (pomoBtn) { openPomo(pomoBtn.dataset.pomo); return; }

  // 4. Notes
  const noteBtn = e.target.closest('[data-note-open]');
  if (noteBtn) { openNotes(noteBtn.dataset.noteOpen); return; }

  // 5. Subtask checkbox
  const subCheck = e.target.closest('.subtask-check');
  if (subCheck) { toggleSubtask(subCheck.dataset.task, parseInt(subCheck.dataset.sub, 10)); return; }

  // 6. Add subtask button
  const addSubBtn = e.target.closest('[data-addsub]');
  if (addSubBtn) { addSubtask(addSubBtn.dataset.addsub); return; }

  // 7. Expand / collapse subtask list
  const toggleBtn = e.target.closest('[data-toggle]');
  if (toggleBtn) {
    const id   = toggleBtn.dataset.toggle;
    const list = document.getElementById(`subs-${id}`);
    if (list) {
      list.hidden = !list.hidden;
      const cnt = (tasks.find(t => t.id === id)?.subtasks || []).length;
      toggleBtn.textContent = `${list.hidden ? '▶' : '▼'} ${cnt} subtask${cnt > 1 ? 's' : ''}`;
      toggleBtn.setAttribute('aria-expanded', String(!list.hidden));
    }
    return;
  }

  // 8. Star / commitment
  const starBtn = e.target.closest('[data-star]');
  if (starBtn && !starBtn.classList.contains('star-disabled')) {
    toggleCommitment(starBtn.dataset.star);
    return;
  }

  // 9. Faded task → decay modal
  const faded = e.target.closest('.task-item.faded');
  if (faded && !e.target.closest('button') && !e.target.closest('input')) {
    openDecayModal(faded.dataset.id);
  }
}

// ── Enter key on subtask input ────────────────────────────────
function handleSubtaskKeydown(e) {
  if (e.key === 'Enter' && e.target.classList.contains('subtask-input')) {
    addSubtask(e.target.id.replace('sub-inp-', ''));
  }
}

// ============================================================
// 9. ADD TASK
// ============================================================

function addTask() {
  const titleEl = document.getElementById('task-input');
  const title   = titleEl.value.trim();
  if (!title) { showToast('Please enter a task title.', 'warning'); return; }

  const tagLabel = document.getElementById('tag-label-input').value.trim();
  const tagColor = document.getElementById('tag-color-input').value;
  const dueDate  = document.getElementById('date-input').value;
  const dueTime  = document.getElementById('time-input').value;
  const priority = document.getElementById('priority-select').value;
  const energy   = document.getElementById('energy-select').value;
  const workspace= document.getElementById('workspace-select').value;
  const isRec    = document.getElementById('recurring-check').checked;
  const recFreq  = document.getElementById('recurring-freq').value;

  const dueAt = dueDate
    ? new Date(`${dueDate}T${dueTime || '23:59'}`).toISOString()
    : null;

  /** @type {Task} */
  const task = {
    id:                 uid(),
    title,
    createdAt:          new Date().toISOString(),
    dueAt,
    completedAt:        null,
    priority,
    energyLevel:        energy,
    workspace,
    tag:                tagLabel ? { label: tagLabel, color: tagColor } : null,
    subtasks:           [],
    notes:              '',
    isRecurring:        isRec,
    recurringFrequency: isRec ? recFreq : null,
    recurringDays:      null,
    streak:             0,
    reflection:         null,
    isCommitment:       false,
    lastTouchedAt:      new Date().toISOString(),
    pomodoroSessions:   0,
    isArchived:         false,
    archiveReason:      null,
    order:              Date.now(),
  };

  tasks.unshift(task);
  saveToStorage();
  renderTasks();

  // Clear form
  ['task-input', 'tag-label-input', 'date-input', 'time-input'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('priority-select').value  = 'medium';
  document.getElementById('energy-select').value    = 'medium';
  document.getElementById('workspace-select').value = 'personal';
  document.getElementById('recurring-check').checked = false;
  document.getElementById('recurring-options').hidden = true;

  showToast(`Task added to ${workspace} ✓`, 'success');
  updateStreakOnActivity();
}

// ============================================================
// 10. DELETE / TOGGLE TASK
// ============================================================

function deleteTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  saveToStorage();
  renderTasks();
  showToast('Task removed', 'info');
}

function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  if (task.completedAt) {
    // Un-complete
    task.completedAt   = null;
    task.reflection    = null;
    task.lastTouchedAt = new Date().toISOString();
    saveToStorage();
    renderTasks();
  } else {
    // Trigger reflection prompt first
    task.lastTouchedAt = new Date().toISOString();
    showReflectionPrompt(id);
  }
}

// ============================================================
// 11. SUBTASKS
// ============================================================

function addSubtask(taskId) {
  const inp = document.getElementById(`sub-inp-${taskId}`);
  if (!inp || !inp.value.trim()) return;
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  task.subtasks.push({ id: uid(), text: inp.value.trim(), done: false });
  task.lastTouchedAt = new Date().toISOString();
  saveToStorage();
  inp.value = '';
  renderTasks();
}

function toggleSubtask(taskId, subIdx) {
  const task = tasks.find(t => t.id === taskId);
  if (!task || !task.subtasks[subIdx]) return;
  task.subtasks[subIdx].done = !task.subtasks[subIdx].done;
  task.lastTouchedAt = new Date().toISOString();
  saveToStorage();
  renderTasks();
}

// ============================================================
// 12. REFLECTION LOOP
// ============================================================

function showReflectionPrompt(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  // Find the rendered card
  const card = document.querySelector(`.task-item[data-id="${taskId}"]`);
  if (!card) return;

  // Remove any existing prompt
  card.querySelector('.reflection-prompt')?.remove();

  const prompt = document.createElement('div');
  prompt.className = 'reflection-prompt';
  prompt.innerHTML = `
    <span>How did this feel?</span>
    <button class="reflect-btn" data-val="smooth">🟢 Smooth</button>
    <button class="reflect-btn" data-val="friction">🟡 Friction</button>
    <button class="reflect-btn" data-val="exhausting">🔴 Exhausting</button>`;
  card.appendChild(prompt);

  // Auto-default after 3 s
  const timer = setTimeout(() => completeTask(taskId, 'smooth'), 3000);

  prompt.querySelectorAll('.reflect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      clearTimeout(timer);
      completeTask(taskId, btn.dataset.val);
    });
  });
}

function completeTask(taskId, reflection) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  task.completedAt   = new Date().toISOString();
  task.reflection    = reflection;
  task.lastTouchedAt = new Date().toISOString();

  // Tally into weekly reflections
  const day = new Date().toLocaleDateString('en-US', { weekday: 'short' });
  if (!reflections[day]) reflections[day] = { smooth: 0, friction: 0, exhausting: 0 };
  reflections[day][reflection] = (reflections[day][reflection] || 0) + 1;

  saveToStorage();
  renderTasks();
  launchConfetti();
  showToast('Nice work! Zen Score updated. 🎉', 'success');
  updateStreakOnActivity();

  if (task.isRecurring) {
    task.streak = (task.streak || 0) + 1;
    scheduleNextRecurrence(task);
    showToast('Next occurrence scheduled ↻', 'info');
  }
}

// ============================================================
// 13. RECURRING TASKS
// ============================================================

function scheduleNextRecurrence(task) {
  const base = task.dueAt ? new Date(task.dueAt) : new Date();
  const next = new Date(base);

  switch (task.recurringFrequency) {
    case 'daily':   next.setDate(next.getDate()    + 1);  break;
    case 'weekly':  next.setDate(next.getDate()    + 7);  break;
    case 'monthly': next.setMonth(next.getMonth()  + 1);  break;
  }

  tasks.unshift({
    ...task,
    id:               uid(),
    createdAt:        new Date().toISOString(),
    dueAt:            next.toISOString(),
    completedAt:      null,
    reflection:       null,
    isCommitment:     false,
    lastTouchedAt:    new Date().toISOString(),
    pomodoroSessions: 0,
    order:            Date.now(),
  });
  saveToStorage();
}

// ============================================================
// 14. TASK DECAY & ARCHIVE
// ============================================================

function openDecayModal(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  decayTaskId = taskId;
  const days = Math.floor((Date.now() - new Date(task.lastTouchedAt)) / 86400000);
  document.getElementById('decay-modal-msg').textContent =
    `"${task.title}" has been dormant for ${days} day${days !== 1 ? 's' : ''}. What would you like to do?`;
  openModal('decay-modal');
}

function handleDecayReschedule() {
  closeModal('decay-modal');
  if (!decayTaskId) return;
  const task = tasks.find(t => t.id === decayTaskId);
  if (!task) return;
  const newDate = prompt('Enter new due date (YYYY-MM-DD):');
  if (newDate) {
    task.dueAt         = new Date(`${newDate}T23:59`).toISOString();
    task.lastTouchedAt = new Date().toISOString();
    saveToStorage(); renderTasks();
    showToast('Task rescheduled 📅', 'success');
  }
}

function handleDecayRelease() {
  closeModal('decay-modal');
  if (!decayTaskId) return;
  const idx = tasks.findIndex(t => t.id === decayTaskId);
  if (idx === -1) return;
  const [task] = tasks.splice(idx, 1);
  task.isArchived    = true;
  task.archiveReason = 'released';
  archive.push(task);
  saveToStorage(); renderTasks();
  showToast('Task released to archive 🌫', 'info');
}

function handleDecayKeep() {
  closeModal('decay-modal');
  if (!decayTaskId) return;
  const task = tasks.find(t => t.id === decayTaskId);
  if (task) { task.lastTouchedAt = new Date().toISOString(); saveToStorage(); renderTasks(); }
}

// ============================================================
// 15. DRAG & DROP — wired inside buildTaskElement (section 8)
// ============================================================

// ============================================================
// 16. FILTERS, SEARCH, SORT
// ============================================================

function initFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderTasks();
    });
  });

  document.querySelectorAll('.ws-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ws-tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      activeWorkspace = tab.dataset.ws;
      renderTasks();
    });
  });

  document.getElementById('search-input').addEventListener('input', e => {
    activeSearch = e.target.value;
    renderTasks();
  });

  document.getElementById('sort-select').addEventListener('change', e => {
    activeSortBy = e.target.value;
    renderTasks();
  });
}

// ============================================================
// 17. TOP 3 COMMITMENTS
// ============================================================

function toggleCommitment(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  if (task.isCommitment) {
    task.isCommitment = false;
  } else {
    if (top3Locked) { showToast('Top 3 is locked. Click Unlock to change.', 'warning'); return; }
    const count = tasks.filter(t => t.isCommitment).length;
    if (count >= 3) { showToast('Only 3 commitments allowed!', 'warning'); return; }
    task.isCommitment = true;
    if (tasks.filter(t => t.isCommitment).length === 3) {
      top3Locked = true;
      localStorage.setItem('mt-top3locked', 'true');
      localStorage.setItem('mt-top3date', todayStr());
      showToast('Top 3 locked in! 🔒', 'success');
    }
  }
  saveToStorage();
  renderTasks();
}

function updateTop3Bar() {
  const bar       = document.getElementById('top3-bar');
  const listEl    = document.getElementById('top3-list');
  const lockIcon  = document.getElementById('top3-lock-icon');
  const unlockBtn = document.getElementById('top3-unlock-btn');
  const commits   = tasks.filter(t => t.isCommitment && !t.isArchived);

  bar.hidden = commits.length === 0;
  if (commits.length === 0) return;

  lockIcon.textContent = top3Locked ? '🔒' : '🔓';
  unlockBtn.hidden     = !top3Locked;
  listEl.innerHTML     = commits.map(t =>
    `<div class="top3-item">${escHtml(t.title)}</div>`
  ).join('');
}

function unlockTop3() {
  if (!confirm('Unlock Top 3 commitments?')) return;
  top3Locked = false;
  localStorage.setItem('mt-top3locked', 'false');
  saveToStorage();
  renderTasks();
  showToast('Top 3 unlocked 🔓', 'info');
}

// ============================================================
// 18. POMODORO TIMER
// ============================================================

function openPomo(taskId) {
  pomoTaskId = taskId;
  const task = tasks.find(t => t.id === taskId);
  document.getElementById('pomo-task-name').textContent = task ? task.title : '';
  resetPomo(false);
  document.getElementById('pomo-overlay').hidden = false;
}

/** @param {boolean} inMonk – true when operating inside Monk Mode */
function resetPomo(inMonk) {
  clearInterval(pomoInterval);
  pomoRunning = false;
  pomoSeconds = POMO_TOTAL;
  const btnId = inMonk ? 'monk-pomo-start' : 'pomo-start';
  const btn   = document.getElementById(btnId);
  if (btn) btn.textContent = 'Start';
  updatePomoDisplay(inMonk);
}

function updatePomoDisplay(inMonk) {
  const m      = String(Math.floor(pomoSeconds / 60)).padStart(2, '0');
  const s      = String(pomoSeconds % 60).padStart(2, '0');
  const offset = 440 * (pomoSeconds / POMO_TOTAL);

  const timeId = inMonk ? 'monk-pomo-time' : 'pomo-time';
  const ringId = inMonk ? 'monk-pomo-ring' : 'pomo-ring';

  const timeEl = document.getElementById(timeId);
  const ringEl = document.getElementById(ringId);
  if (timeEl) timeEl.textContent = `${m}:${s}`;
  if (ringEl) ringEl.style.strokeDashoffset = 440 - offset;
}

function startPausePomo(inMonk) {
  const btnId = inMonk ? 'monk-pomo-start' : 'pomo-start';
  const btn   = document.getElementById(btnId);

  if (pomoRunning) {
    clearInterval(pomoInterval);
    pomoRunning = false;
    if (btn) btn.textContent = 'Resume';
  } else {
    pomoRunning = true;
    if (btn) btn.textContent = 'Pause';
    pomoInterval = setInterval(() => {
      if (pomoSeconds <= 0) {
        clearInterval(pomoInterval);
        pomoRunning = false;
        pomoSessions++;
        localStorage.setItem('mt-pomo-today', String(pomoSessions));
        if (pomoTaskId) {
          const t = tasks.find(x => x.id === pomoTaskId);
          if (t) { t.pomodoroSessions = (t.pomodoroSessions || 0) + 1; }
          saveToStorage();
        }
        showToast('🍅 Pomodoro complete! Take a break.', 'success');
        launchConfetti();
        updateZenScore();
        return;
      }
      pomoSeconds--;
      updatePomoDisplay(inMonk);
    }, 1000);
  }
}

// ============================================================
// 19. MONK MODE
// ============================================================

function openMonkMode() {
  // Pick the first commitment, otherwise first uncompleted task
  const target = tasks.find(t => t.isCommitment && !t.completedAt)
               || tasks.find(t => !t.completedAt);

  if (!target) { showToast('Add a task first to enter Monk Mode.', 'warning'); return; }

  monkTaskId = target.id;
  document.getElementById('monk-task-title').textContent = target.title;

  // Render subtasks inside monk mode
  const subsEl = document.getElementById('monk-subtasks');
  subsEl.innerHTML = (target.subtasks || []).map(s => `
    <div class="monk-subtask-row">
      <span>${s.done ? '✓' : '○'}</span>
      <span>${escHtml(s.text)}</span>
    </div>`).join('');

  pomoTaskId = target.id;
  resetPomo(true);
  document.getElementById('monk-overlay').hidden = false;
  showToast('Monk Mode — stay focused. 🧘', 'info');
}

function exitMonkMode() {
  clearInterval(pomoInterval);
  pomoRunning = false;
  document.getElementById('monk-overlay').hidden = true;
  monkTaskId = null;
}

// ============================================================
// 20. NOTES PANEL
// ============================================================

function openNotes(taskId) {
  noteTaskId = taskId;
  const task = tasks.find(t => t.id === taskId);
  document.getElementById('notes-task-label').textContent  = task ? task.title : '';
  document.getElementById('notes-textarea').value          = task ? (task.notes || '') : '';
  document.getElementById('notes-overlay').classList.add('open');
}

function closeNotes() {
  document.getElementById('notes-overlay').classList.remove('open');
}

/** Auto-save notes on every keystroke */
function autoSaveNote() {
  if (!noteTaskId) return;
  const task = tasks.find(t => t.id === noteTaskId);
  if (task) {
    task.notes         = document.getElementById('notes-textarea').value;
    task.lastTouchedAt = new Date().toISOString();
    saveToStorage();
  }
}

// ============================================================
// 21. EISENHOWER MATRIX VIEW
// ============================================================

function toggleMatrixView() {
  matrixOpen = !matrixOpen;
  const matrixEl = document.getElementById('matrix-view');
  const listEl   = document.getElementById('task-list');
  const emptyEl  = document.getElementById('empty-state');
  const btn      = document.getElementById('matrix-toggle-btn');

  matrixEl.hidden = !matrixOpen;
  listEl.hidden   =  matrixOpen;
  if (matrixOpen) emptyEl.classList.remove('visible');

  btn.style.background = matrixOpen ? 'var(--accent)' : '';
  btn.style.color      = matrixOpen ? '#fff'          : '';

  if (matrixOpen) renderMatrix();
  else renderTasks();
}

function getMatrixQuadrant(task) {
  const urgent    = !!(task.dueAt && (new Date(task.dueAt) - Date.now()) < 86400000);
  const important = task.priority === 'high';
  if (urgent && important)   return 'do';
  if (!urgent && important)  return 'schedule';
  if (urgent && !important)  return 'delegate';
  return 'eliminate';
}

function renderMatrix() {
  ['do', 'schedule', 'delegate', 'eliminate'].forEach(q => {
    const cont = document.querySelector(`#matrix-${q} .matrix-task-list`);
    if (!cont) return;
    cont.innerHTML = '';

    tasks
      .filter(t => !t.isArchived && !t.completedAt && getMatrixQuadrant(t) === q)
      .forEach(task => {
        const chip = document.createElement('div');
        chip.className     = 'matrix-task-chip';
        chip.draggable     = true;
        chip.dataset.id    = task.id;
        chip.textContent   = task.title;
        chip.title         = task.title;

        chip.addEventListener('dragstart', e => {
          dragSrcId = task.id;
          e.dataTransfer.effectAllowed = 'move';
        });
        cont.appendChild(chip);
      });

    cont.addEventListener('dragover', e => e.preventDefault());
    cont.addEventListener('drop', e => {
      e.preventDefault();
      if (!dragSrcId) return;
      const task = tasks.find(t => t.id === dragSrcId);
      if (!task) return;
      const quadrant = cont.closest('.matrix-quadrant').dataset.q;
      if (quadrant === 'do')        { task.priority = 'high'; task.dueAt = new Date(Date.now() + 3_600_000).toISOString(); }
      if (quadrant === 'schedule')  { task.priority = 'high'; task.dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString(); }
      if (quadrant === 'delegate')  { task.priority = 'low';  task.dueAt = new Date(Date.now() + 3_600_000).toISOString(); }
      if (quadrant === 'eliminate') { task.priority = 'low';  task.dueAt = null; }
      saveToStorage();
      renderMatrix();
    });
  });
}

// ============================================================
// 22. DONE WALL
// ============================================================

function openDoneWall() {
  document.getElementById('done-wall').hidden = false;
  renderDoneWall('');
}

function closeDoneWall() {
  document.getElementById('done-wall').hidden = true;
}

function renderDoneWall(searchQ) {
  // ── Lifetime stats ───────────────────────────────────────
  const allDone    = [...tasks, ...archive].filter(t => t.completedAt);
  const totalFocus = tasks.reduce((acc, t) => acc + (t.pomodoroSessions || 0), 0)
                   + archive.reduce((acc, t) => acc + (t.pomodoroSessions || 0), 0);
  const streak     = getStreak();
  const wsCount    = { work: 0, personal: 0, study: 0 };
  allDone.forEach(t => { if (wsCount[t.workspace] !== undefined) wsCount[t.workspace]++; });
  const topWs      = Object.entries(wsCount).sort((a, b) => b[1] - a[1])[0][0];

  document.getElementById('lifetime-stats').innerHTML = `
    <div class="lifetime-stat">
      <div class="ls-label">Completed</div>
      <div class="ls-value">${allDone.length}</div>
    </div>
    <div class="lifetime-stat">
      <div class="ls-label">Focus Sessions</div>
      <div class="ls-value">${totalFocus}</div>
    </div>
    <div class="lifetime-stat">
      <div class="ls-label">Streak</div>
      <div class="ls-value">${streak} days</div>
    </div>
    <div class="lifetime-stat">
      <div class="ls-label">Top Workspace</div>
      <div class="ls-value" style="font-size:16px">${topWs}</div>
    </div>`;

  // ── Grouped list ─────────────────────────────────────────
  const q    = searchQ.toLowerCase();
  const done = allDone
    .filter(t => !q || t.title.toLowerCase().includes(q))
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));

  const groups = {};
  done.forEach(t => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d     = new Date(t.completedAt); d.setHours(0, 0, 0, 0);
    const diff  = Math.round((today - d) / 86400000);
    const grp   = diff === 0 ? 'Today'
                : diff === 1 ? 'Yesterday'
                : diff <= 7  ? 'This Week'
                :              'Earlier';
    if (!groups[grp]) groups[grp] = [];
    groups[grp].push(t);
  });

  const listEl = document.getElementById('done-wall-list');
  listEl.innerHTML = '';

  ['Today', 'Yesterday', 'This Week', 'Earlier'].forEach(grp => {
    if (!groups[grp]) return;
    const label = document.createElement('div');
    label.className   = 'done-group-label';
    label.textContent = grp;
    listEl.appendChild(label);

    groups[grp].forEach(t => {
      const item = document.createElement('div');
      item.className = 'done-item';
      const dot = t.reflection
        ? `<div class="reflection-dot ${t.reflection}" title="${t.reflection}"></div>` : '';
      item.innerHTML = `
        <div class="done-item-title">${escHtml(t.title)}</div>
        <span class="ws-badge">${t.workspace}</span>
        <span style="font-size:11px;color:var(--muted)">
          ${new Date(t.completedAt).toLocaleString()}
        </span>
        ${dot}`;
      listEl.appendChild(item);
    });
  });

  if (done.length === 0) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--muted);padding:40px">No completed tasks yet. Keep going! 🌱</div>';
  }
}

// ============================================================
// 23. WEEKLY REFLECTION CHART  (Canvas)
// ============================================================

function drawReflectionChart() {
  const canvas = document.getElementById('reflection-chart');
  if (!canvas) return;
  const ctx  = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const days   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const colW   = W / days.length;
  const maxVal = 5;
  const barW   = colW * 0.22;
  const isLight= document.documentElement.dataset.theme === 'light';
  const textCl = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.30)';

  days.forEach((day, i) => {
    const data = reflections[day] || { smooth: 0, friction: 0, exhausting: 0 };
    const cx   = i * colW + colW / 2;
    const bh   = (H - 28) / maxVal;

    // smooth (green)
    const sh = Math.min(data.smooth * bh, H - 28);
    ctx.fillStyle = '#52d68a88';
    ctx.fillRect(cx - barW * 1.5, H - 18 - sh, barW, sh);

    // friction (gold)
    const fh = Math.min(data.friction * bh, H - 28);
    ctx.fillStyle = '#f4c66a88';
    ctx.fillRect(cx - barW * 0.5, H - 18 - fh, barW, fh);

    // exhausting (coral)
    const eh = Math.min(data.exhausting * bh, H - 28);
    ctx.fillStyle = '#f9717188';
    ctx.fillRect(cx + barW * 0.5, H - 18 - eh, barW, eh);

    // day label
    ctx.fillStyle  = textCl;
    ctx.font       = '10px DM Sans, sans-serif';
    ctx.textAlign  = 'center';
    ctx.fillText(day, cx, H - 4);
  });

  // Legend
  ctx.textAlign = 'left';
  ctx.font      = '10px DM Sans, sans-serif';
  ctx.fillStyle = textCl;
  [['🟢 Smooth', '#52d68a'], ['🟡 Friction', '#f4c66a'], ['🔴 Exhausting', '#f97171']]
    .forEach(([lbl], li) => ctx.fillText(lbl, W - 190, 13 + li * 14));
}

// ============================================================
// 24. CONFETTI  (Canvas — no library)
// ============================================================

function launchConfetti() {
  const canvas    = document.getElementById('confetti-canvas');
  canvas.width    = window.innerWidth;
  canvas.height   = window.innerHeight;
  const ctx       = canvas.getContext('2d');
  const brand     = ['#7c6fea', '#4fd6c8', '#f97171', '#f4c66a', '#52d68a'];

  const pieces = Array.from({ length: 80 }, () => ({
    x:  Math.random() * canvas.width,
    y:  Math.random() * canvas.height * -0.4,
    w:  5 + Math.random() * 9,
    h:  9 + Math.random() * 13,
    c:  brand[Math.floor(Math.random() * brand.length)],
    r:  Math.random() * Math.PI * 2,
    vx: -2 + Math.random() * 4,
    vy: 2.5 + Math.random() * 4.5,
    vr: -0.12 + Math.random() * 0.24,
  }));

  let frame = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach(p => {
      ctx.save();
      ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
      ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
      p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vy += 0.09;
    });
    if (++frame < 150) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  draw();
}

// ============================================================
// 25. SOUNDSCAPE  (Web Audio API — programmatic, no MP3)
// ============================================================

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function stopAllSound() {
  soundNodes.forEach(n => { try { n.stop(); } catch (_) {} });
  soundNodes = [];
}

/**
 * Generates a looped noise buffer.
 * @param {'white'|'brown'} type
 */
function createNoiseBuffer(type) {
  const len  = audioCtx.sampleRate * 2;
  const buf  = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'brown') {
      b0 = 0.99886*b0 + w*0.0555179; b1 = 0.99332*b1 + w*0.0750759;
      b2 = 0.96900*b2 + w*0.1538520; b3 = 0.86650*b3 + w*0.3104856;
      b4 = 0.55000*b4 + w*0.5329522; b5 = -0.7616*b5 - w*0.0168980;
      data[i] = (b0+b1+b2+b3+b4+b5+b6 + w*0.5362) / 7;
      b6 = w * 0.115926;
    } else {
      data[i] = w; // white
    }
  }
  return buf;
}

function playNoise(type) {
  ensureAudioCtx();
  stopAllSound();
  const src  = audioCtx.createBufferSource();
  src.buffer = createNoiseBuffer(type);
  src.loop   = true;

  const filter = audioCtx.createBiquadFilter();
  filter.type  = type === 'white' ? 'highpass' : 'lowpass';
  filter.frequency.value = type === 'white' ? 1000 : 400;

  const gain = audioCtx.createGain();
  gain.gain.value = soundVolume * 0.4;

  src.connect(filter);
  filter.connect(gain);
  gain.connect(audioCtx.destination);
  src.start();
  soundNodes = [src];
}

function playRain() {
  ensureAudioCtx();
  stopAllSound();
  for (let i = 0; i < 4; i++) {
    const src    = audioCtx.createBufferSource();
    src.buffer   = createNoiseBuffer('white');
    src.loop     = true;

    const filter = audioCtx.createBiquadFilter();
    filter.type  = 'bandpass';
    filter.frequency.value = 350 + i * 180;
    filter.Q.value = 0.55;

    const pan = audioCtx.createStereoPanner();
    pan.pan.value = -0.6 + i * 0.4;

    const gain = audioCtx.createGain();
    gain.gain.value = soundVolume * 0.14;

    src.connect(filter); filter.connect(pan); pan.connect(gain);
    gain.connect(audioCtx.destination);
    src.start(audioCtx.currentTime + i * 0.08);
    soundNodes.push(src);
  }
}

function applySound(type) {
  currentSound = type;
  localStorage.setItem('mt-sound', type);

  document.querySelectorAll('.sound-opt').forEach(b => b.classList.remove('active'));
  document.querySelector(`.sound-opt[data-sound="${type}"]`)?.classList.add('active');

  if (type === 'off')   { stopAllSound(); stopWaveform(); return; }
  if (type === 'white') playNoise('white');
  if (type === 'brown') playNoise('brown');
  if (type === 'rain')  playRain();
  startWaveform();
}

function setVolume(vol) {
  soundVolume = vol;
  localStorage.setItem('mt-vol', String(vol));
  // Restart with updated volume
  if (currentSound !== 'off') applySound(currentSound);
}

// ── Waveform animation ────────────────────────────────────────
function startWaveform() {
  const poly = document.getElementById('wave-line');
  if (!poly) return;
  if (waveAnimId) cancelAnimationFrame(waveAnimId);
  let t = 0;
  function step() {
    t += 0.065;
    const pts = [];
    for (let x = 0; x <= 120; x += 10) {
      const y = 15 + Math.sin(x * 0.14 + t) * 6 + Math.sin(x * 0.28 + t * 1.4) * 3;
      pts.push(`${x},${y.toFixed(1)}`);
    }
    poly.setAttribute('points', pts.join(' '));
    waveAnimId = requestAnimationFrame(step);
  }
  step();
}

function stopWaveform() {
  if (waveAnimId) cancelAnimationFrame(waveAnimId);
  waveAnimId = null;
  const poly = document.getElementById('wave-line');
  if (poly) poly.setAttribute('points', '0,15 20,15 40,15 60,15 80,15 100,15 120,15');
}

// ============================================================
// 26. THEME TOGGLE
// ============================================================

function toggleTheme() {
  const html    = document.documentElement;
  const isLight = html.dataset.theme === 'light';
  html.dataset.theme = isLight ? 'dark' : 'light';
  localStorage.setItem('mt-theme', html.dataset.theme);
  document.getElementById('theme-btn').textContent = isLight ? '🌙' : '☀';
  drawReflectionChart();
}

function loadTheme() {
  const saved = localStorage.getItem('mt-theme') || 'dark';
  document.documentElement.dataset.theme = saved;
  document.getElementById('theme-btn').textContent = saved === 'light' ? '☀' : '🌙';
}

// ============================================================
// 27. MOOD CHECK-IN OVERLAY
// ============================================================

function checkMoodCheckIn() {
  if (localStorage.getItem('mt-mood-date') === todayStr()) return;
  // Set greeting
  const greetMap = { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Good night' };
  const name     = localStorage.getItem('mt-name') || '';
  document.getElementById('mood-greeting').textContent =
    `${greetMap[getTimeOfDay()]}${name ? `, ${name}` : ''} 👋`;
  if (name) document.getElementById('mood-name-input').value = name;

  // Live slider labels
  ['energy', 'focus', 'stress'].forEach(key => {
    const slider = document.getElementById(`mood-${key}`);
    const valEl  = document.getElementById(`mood-${key}-val`);
    slider?.addEventListener('input', () => { if (valEl) valEl.textContent = slider.value; });
  });

  document.getElementById('mood-overlay').hidden = false;
}

function submitMood() {
  const name   = document.getElementById('mood-name-input').value.trim();
  const energy = parseInt(document.getElementById('mood-energy').value, 10);
  const focus  = parseInt(document.getElementById('mood-focus').value, 10);
  const stress = parseInt(document.getElementById('mood-stress').value, 10);

  if (name) localStorage.setItem('mt-name', name);
  moods.push({ date: new Date().toISOString(), energy, focus, stress });
  localStorage.setItem('mt-mood-date', todayStr());
  saveToStorage();

  document.getElementById('mood-overlay').hidden = true;

  // Apply mood-based adjustments
  if (energy < 4) {
    activeFilter = 'low';
    document.querySelectorAll('.filter-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.filter === 'low')
    );
    showToast('Low energy? Showing easy tasks 🌙', 'info');
  }
  if (stress > 7) showToast('High stress — consider starting with something small 🌱', 'warning');
  if (focus  > 7) showToast('Peak focus! High-energy tasks are highlighted ⭐', 'success');
  renderTasks();
}

// ============================================================
// 28. TOAST NOTIFICATIONS
// ============================================================

let activeToasts = 0;

function showToast(msg, type = 'info') {
  if (activeToasts >= 3) return;
  const container = document.getElementById('toast-container');
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  activeToasts++;
  setTimeout(() => { toast.remove(); activeToasts--; }, 3000);
}

// ============================================================
// 29. STREAK LOGIC
// ============================================================

function getStreak() {
  const data = JSON.parse(localStorage.getItem('mt-streak') || '{"count":0,"last":""}');
  return data.count;
}

function updateStreakOnActivity() {
  const data      = JSON.parse(localStorage.getItem('mt-streak') || '{"count":0,"last":""}');
  const today     = todayStr();
  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (data.last === today) return;
  data.count = (data.last === yesterday) ? data.count + 1 : 1;
  data.last  = today;
  localStorage.setItem('mt-streak', JSON.stringify(data));
}

// ============================================================
// 30. EXPORT / IMPORT
// ============================================================

function exportTasks() {
  const payload = {
    tasks, archive, moods, reflections,
    exportedAt: new Date().toISOString(),
    app: 'MeTime+',
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `metime-tasks-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
  showToast('Tasks exported ✓', 'success');
}

function triggerImport() {
  document.getElementById('import-file-input').click();
}

function importTasks(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      importFileData = JSON.parse(e.target.result);
      openModal('import-modal');
    } catch {
      showToast('Invalid JSON file', 'error');
    }
  };
  reader.readAsText(file);
}

function confirmImport() {
  if (!importFileData) return;
  if (Array.isArray(importFileData.tasks))      tasks       = [...tasks,   ...importFileData.tasks];
  if (Array.isArray(importFileData.archive))    archive     = [...archive, ...importFileData.archive];
  if (Array.isArray(importFileData.moods))      moods       = [...moods,   ...importFileData.moods];
  if (importFileData.reflections) Object.assign(reflections, importFileData.reflections);
  saveToStorage(); renderTasks();
  closeModal('import-modal');
  showToast('Tasks imported ✓', 'success');
  importFileData = null;
}

// ============================================================
// 31. KEYBOARD SHORTCUTS
// ============================================================

function initKeyboard() {
  document.addEventListener('keydown', e => {
    const tag    = document.activeElement.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    if (e.key === 'Escape') {
      closeModal('kb-modal');
      closeModal('decay-modal');
      closeModal('import-modal');
      closeNotes();
      if (!document.getElementById('pomo-overlay').hidden) {
        clearInterval(pomoInterval); pomoRunning = false;
        document.getElementById('pomo-overlay').hidden = true;
      }
      if (!document.getElementById('monk-overlay').hidden) exitMonkMode();
      if (!document.getElementById('done-wall').hidden)    closeDoneWall();
      if (!document.getElementById('mood-overlay').hidden) submitMood();
      return;
    }

    if (!typing) {
      switch (e.key.toLowerCase()) {
        case 'n': e.preventDefault(); document.getElementById('task-input').focus(); break;
        case 't': toggleTheme(); break;
        case 'm':
          if (!document.getElementById('monk-overlay').hidden) exitMonkMode();
          else openMonkMode();
          break;
        case 's': applySound(currentSound === 'off' ? 'white' : 'off'); break;
        case 'p': {
          const monkOpen = !document.getElementById('monk-overlay').hidden;
          const pomoOpen = !document.getElementById('pomo-overlay').hidden;
          if (monkOpen)      startPausePomo(true);
          else if (pomoOpen) startPausePomo(false);
          else {
            const first = tasks.find(t => !t.completedAt);
            if (first) openPomo(first.id);
          }
          break;
        }
        case '?': openModal('kb-modal'); break;
      }
    }

    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      document.getElementById('search-input').focus();
    }
  });
}

// ============================================================
// 32. INIT — wires all event listeners, bootstraps the app
// ============================================================

function init() {
  loadFromStorage();
  loadTheme();
  buildParticles();

  // ── Add task ──────────────────────────────────────────────
  document.getElementById('add-btn').addEventListener('click', addTask);
  document.getElementById('task-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addTask();
  });

  // Recurring checkbox reveals frequency select
  document.getElementById('recurring-check').addEventListener('change', e => {
    document.getElementById('recurring-options').hidden = !e.target.checked;
  });

  // ── Task list delegation ──────────────────────────────────
  document.getElementById('task-list').addEventListener('click',   handleTaskItemClick);
  document.getElementById('task-list').addEventListener('keydown', handleSubtaskKeydown);

  // ── Filters / workspaces / search / sort ─────────────────
  initFilters();

  // ── Clear completed → archive ─────────────────────────────
  document.getElementById('clear-done-btn').addEventListener('click', () => {
    tasks.forEach(t => {
      if (t.completedAt) { t.isArchived = true; t.archiveReason = 'completed'; archive.push(t); }
    });
    tasks = tasks.filter(t => !t.isArchived);
    saveToStorage(); renderTasks();
    showToast('Completed tasks archived', 'info');
  });

  // ── Theme ─────────────────────────────────────────────────
  document.getElementById('theme-btn').addEventListener('click', toggleTheme);

  // ── Keyboard shortcuts modal ──────────────────────────────
  document.getElementById('kb-btn').addEventListener('click', () => openModal('kb-modal'));

  // Close any modal via data-close attribute
  document.querySelectorAll('[data-close]').forEach(btn =>
    btn.addEventListener('click', () => closeModal(btn.dataset.close))
  );

  // Close modal overlays on backdrop click
  document.querySelectorAll('.modal-overlay').forEach(overlay =>
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.hidden = true; })
  );

  // ── Export / Import ───────────────────────────────────────
  document.getElementById('export-btn').addEventListener('click', exportTasks);
  document.getElementById('import-btn').addEventListener('click', triggerImport);
  document.getElementById('import-file-input').addEventListener('change', e => {
    if (e.target.files[0]) importTasks(e.target.files[0]);
    e.target.value = ''; // reset so same file can be re-imported
  });
  document.getElementById('import-confirm').addEventListener('click', confirmImport);

  // ── Mood overlay ──────────────────────────────────────────
  document.getElementById('mood-submit').addEventListener('click', submitMood);

  // ── Monk mode ─────────────────────────────────────────────
  document.getElementById('monk-btn').addEventListener('click', openMonkMode);
  document.getElementById('monk-exit').addEventListener('click', exitMonkMode);
  document.getElementById('monk-pomo-start').addEventListener('click', () => startPausePomo(true));
  document.getElementById('monk-pomo-reset').addEventListener('click', () => resetPomo(true));

  // ── Pomodoro modal ────────────────────────────────────────
  document.getElementById('pomo-start').addEventListener('click', () => startPausePomo(false));
  document.getElementById('pomo-reset').addEventListener('click', () => resetPomo(false));
  document.getElementById('pomo-close').addEventListener('click', () => {
    clearInterval(pomoInterval); pomoRunning = false;
    document.getElementById('pomo-overlay').hidden = true;
  });

  // ── Notes panel ───────────────────────────────────────────
  document.getElementById('notes-close').addEventListener('click', closeNotes);
  document.getElementById('notes-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('notes-overlay')) closeNotes();
  });
  document.getElementById('notes-textarea').addEventListener('input', autoSaveNote);

  // ── Matrix view ───────────────────────────────────────────
  document.getElementById('matrix-toggle-btn').addEventListener('click', toggleMatrixView);

  // ── Done wall ─────────────────────────────────────────────
  document.getElementById('done-wall-btn').addEventListener('click', openDoneWall);
  document.getElementById('done-wall-back').addEventListener('click', closeDoneWall);
  document.getElementById('celebrate-btn').addEventListener('click', launchConfetti);
  document.getElementById('done-wall-search').addEventListener('input', e =>
    renderDoneWall(e.target.value)
  );

  // ── Top-3 commitments ─────────────────────────────────────
  document.getElementById('top3-unlock-btn').addEventListener('click', unlockTop3);

  // ── Decay modal actions ───────────────────────────────────
  document.getElementById('decay-reschedule').addEventListener('click', handleDecayReschedule);
  document.getElementById('decay-keep').addEventListener('click',       handleDecayKeep);
  document.getElementById('decay-delete').addEventListener('click',     handleDecayRelease);

  // ── Soundscape ────────────────────────────────────────────
  document.querySelectorAll('.sound-opt').forEach(btn =>
    btn.addEventListener('click', () => applySound(btn.dataset.sound))
  );
  document.getElementById('sound-toggle').addEventListener('click', () =>
    applySound(currentSound === 'off' ? 'white' : 'off')
  );
  document.getElementById('sound-volume').addEventListener('input', e => {
    soundVolume = parseFloat(e.target.value) / 100;
    localStorage.setItem('mt-vol', String(soundVolume));
    if (currentSound !== 'off') applySound(currentSound);
  });
  // Restore saved volume slider position
  document.getElementById('sound-volume').value = Math.round(soundVolume * 100);

  // ── Keyboard shortcuts ────────────────────────────────────
  initKeyboard();

  // ── Mood check-in (once per day) ─────────────────────────
  checkMoodCheckIn();

  // ── Initial render ────────────────────────────────────────
  renderTasks();
  updateStreakOnActivity();
}

// ── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);