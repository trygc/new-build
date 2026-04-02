/* trygc-patch: assignment alerts + global presence */
(function () {
  'use strict';

  var PROJECT_ID = 'tabwjvmkvqhimlrszbwh';
  var PUBLIC_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRhYndqdm1rdnFoaW1scnN6YndoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIyNjExNDgsImV4cCI6MjA4NzgzNzE0OH0.9PN-Fq77HSRXJ_ZrFGb_xZbKkn0KH5ZFNtAn6larwZM';
  var API_BASE = 'https://' + PROJECT_ID + '.supabase.co/functions/v1/make-server-b626472b';
  var AUTH_KEYS = ['supabase.auth.token', 'sb-' + PROJECT_ID + '-auth-token'];
  var NOTIF_KEY = 'trygc-task-notifications';
  var TOAST_HOST_ID = 'trygc-patch-toast-host';
  var SNAPSHOT_POLL_MS = 8000;
  var HEARTBEAT_MS = 30000;
  var BACKGROUND_POLL_MS = 25000;
  var FETCH_TIMEOUT_MS = 12000;
  var SNAPSHOT_CACHE_TTL_MS = 120000;
  var SNAPSHOT_CACHE_KEY = 'trygc-live-ops-snapshots';
  var ROUTE_SYNC_DEBOUNCE_MS = 120;

  var initialized = false;
  var seenNotifIds = new Set();
  var recentAlertIds = new Set();
  var currentAssignments = new Map();
  var hasAssignmentBaseline = false;
  var latestWorkspaceSnapshot = null;
  var latestCommunitySnapshot = null;
  var liveUsers = [];
  var toastHost = null;
  var audioContext = null;
  var supabaseClientPromise = null;
  var presenceChannel = null;
  var presenceIdentity = '';
  var heartbeatTimer = null;
  var refreshTimer = null;
  var refreshScheduleTimer = null;
  var routeObserver = null;
  var routeSyncTimer = null;
  var refreshInFlight = false;
  var rawLocalSetItem = null;
  var presenceUnloadBound = false;
  var widgetSignature = '';
  var panelSignature = '';
  var lastSnapshotStamp = '';
  var opsPageState = {
    host: null,
    panel: null,
    widget: null,
    sourcePath: '',
    selectedAssignee: '',
    selectedTaskId: '',
    searchQuery: '',
    statusFilter: 'all',
    sourceFilter: 'all',
    open: false
  };
  var notificationSortLock = false;

  function getStoredJson(key) {
    try {
      var raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function getCurrentUser() {
    var i;
    for (i = 0; i < AUTH_KEYS.length; i += 1) {
      var payload = getStoredJson(AUTH_KEYS[i]);
      if (!payload) continue;

      var user =
        payload.user ||
        (payload.currentSession && payload.currentSession.user) ||
        (payload.session && payload.session.user) ||
        payload;

      if (user && user.email) {
        return {
          email: String(user.email || ''),
          name:
            String(
              (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) ||
                user.name ||
                user.email ||
                ''
            ) || ''
        };
      }
    }

    return null;
  }

  function ensureToastHost() {
    if (toastHost && document.body && document.body.contains(toastHost)) return toastHost;

    toastHost = document.getElementById(TOAST_HOST_ID);
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.id = TOAST_HOST_ID;
      toastHost.style.position = 'fixed';
      toastHost.style.right = '16px';
      toastHost.style.bottom = '16px';
      toastHost.style.zIndex = '2147483647';
      toastHost.style.display = 'flex';
      toastHost.style.flexDirection = 'column';
      toastHost.style.gap = '10px';
      toastHost.style.maxWidth = '360px';
      toastHost.style.pointerEvents = 'none';
      document.body.appendChild(toastHost);
    }

    return toastHost;
  }

  function showToast(title, body) {
    if (!document.body) return;

    var host = ensureToastHost();
    var item = document.createElement('div');
    item.style.pointerEvents = 'auto';
    item.style.border = '1px solid rgba(255,255,255,0.12)';
    item.style.background = 'rgba(10,10,10,0.96)';
    item.style.color = '#fff';
    item.style.borderRadius = '18px';
    item.style.boxShadow = '0 20px 50px rgba(0,0,0,0.35)';
    item.style.padding = '14px 16px';
    item.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    item.style.transform = 'translateY(8px)';
    item.style.opacity = '0';
    item.style.transition = 'opacity 160ms ease, transform 160ms ease';

    var titleEl = document.createElement('div');
    titleEl.textContent = title;
    titleEl.style.fontSize = '12px';
    titleEl.style.fontWeight = '800';
    titleEl.style.letterSpacing = '0.12em';
    titleEl.style.textTransform = 'uppercase';
    titleEl.style.color = 'rgba(255,255,255,0.72)';
    titleEl.style.marginBottom = '6px';

    var bodyEl = document.createElement('div');
    bodyEl.textContent = body;
    bodyEl.style.fontSize = '13px';
    bodyEl.style.fontWeight = '600';
    bodyEl.style.lineHeight = '1.45';

    item.appendChild(titleEl);
    item.appendChild(bodyEl);
    host.appendChild(item);

    window.requestAnimationFrame(function () {
      item.style.opacity = '1';
      item.style.transform = 'translateY(0)';
    });

    window.setTimeout(function () {
      item.style.opacity = '0';
      item.style.transform = 'translateY(8px)';
      window.setTimeout(function () {
        if (item.parentNode) item.parentNode.removeChild(item);
      }, 180);
    }, 6000);
  }

  function ensureAudio() {
    if (audioContext) return audioContext;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioContext = new Ctx();
    return audioContext;
  }

  function primeAudio() {
    var ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(function () {});
    }
  }

  function playSound() {
    try {
      var ctx = ensureAudio();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(function () {});
      }

      function tone(freq, t0, dur, vol) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(vol, t0);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      }

      var now = ctx.currentTime;
      tone(880, now, 0.1, 0.28);
      tone(1174, now + 0.12, 0.16, 0.2);
      tone(1567, now + 0.28, 0.24, 0.15);
    } catch (err) {}
  }

  function requestPermEarly() {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') return;

    var fired = false;
    var handler = function () {
      if (fired) return;
      fired = true;
      document.removeEventListener('click', handler, true);
      document.removeEventListener('keydown', handler, true);
      primeAudio();
      Notification.requestPermission().catch(function () {});
    };

    document.addEventListener('click', handler, true);
    document.addEventListener('keydown', handler, true);
  }

  function showBrowserNotif(title, body) {
    if (!('Notification' in window)) return;

    function trigger() {
      try {
        new Notification(title, {
          body: body,
          icon: '/trygc-favicon.png',
          badge: '/trygc-favicon.png',
          tag: 'trygc-live-assignment'
        });
      } catch (err) {}
    }

    if (Notification.permission === 'granted') {
      trigger();
    }
  }

  function normalizeAssignee(task) {
    var email = task.assignedToEmail || '';
    var name = task.assignedToName || task.assignedTo || '';
    var mode = task.assignmentMode || '';
    var value = email || name;
    return {
      email: String(email || '').trim().toLowerCase(),
      name: String(name || '').trim(),
      mode: String(mode || '').trim().toLowerCase(),
      value: String(value || '').trim()
    };
  }

  function normalizeLabel(task) {
    return String(task.title || task.taskName || task.description || 'Untitled task').trim();
  }

  function normalizeContext(task, fallback) {
    return String(task.campaign || task.country || task.teamName || fallback || 'Workspace').trim();
  }

  function statusTone(value) {
    var status = String(value || '').trim().toLowerCase();
    if (/done|complete|completed|closed/.test(status)) return 'done';
    if (/block|stuck|hold/.test(status)) return 'blocked';
    if (/progress|active|working|review|doing/.test(status)) return 'progress';
    return 'pending';
  }

  function sourceLabel(value) {
    var source = String(value || '').trim().toLowerCase();
    if (source === 'community') return 'Community';
    if (source === 'campaign') return 'Campaign';
    if (source === 'standalone') return 'Standalone';
    return 'Workspace';
  }

  function normalizeOpsFilter(value) {
    return String(value || '').trim().toLowerCase() || 'all';
  }

  function formatSnapshotStamp(value) {
    if (!value) return 'Awaiting live data';
    var parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return 'Awaiting live data';
    return parsed.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function deriveSnapshotStamp(workspace, community) {
    var candidates = [
      workspace && workspace.updatedAt,
      community && community.updatedAt,
      community && community.data && community.data.updatedAt
    ];
    var latest = '';
    var latestTime = 0;
    candidates.forEach(function (candidate) {
      if (!candidate) return;
      var time = new Date(candidate).getTime();
      if (!Number.isNaN(time) && time >= latestTime) {
        latestTime = time;
        latest = candidate;
      }
    });
    return latest;
  }

  function readSnapshotCache() {
    try {
      var raw = window.localStorage.getItem(SNAPSHOT_CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!parsed.savedAt || Date.now() - Number(parsed.savedAt) > SNAPSHOT_CACHE_TTL_MS) {
        return null;
      }
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function writeSnapshotCache(workspace, community) {
    try {
      window.localStorage.setItem(
        SNAPSHOT_CACHE_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          workspace: workspace || {},
          community: community || {}
        })
      );
    } catch (err) {}
  }

  function hydrateSnapshotsFromCache() {
    var cached = readSnapshotCache();
    if (!cached) return false;
    latestWorkspaceSnapshot = cached.workspace || {};
    latestCommunitySnapshot = cached.community || {};
    lastSnapshotStamp = deriveSnapshotStamp(latestWorkspaceSnapshot, latestCommunitySnapshot);
    return true;
  }

  function filterOpsTasks(tasks) {
    var query = normalizeOpsFilter(opsPageState.searchQuery);
    var statusFilter = normalizeOpsFilter(opsPageState.statusFilter);
    var sourceFilter = normalizeOpsFilter(opsPageState.sourceFilter);

    return tasks.filter(function (task) {
      if (statusFilter !== 'all' && normalizeOpsFilter(task.status) !== statusFilter) return false;
      if (sourceFilter !== 'all' && normalizeOpsFilter(task.sourceType) !== sourceFilter) return false;
      if (!query) return true;

      var haystack = [
        task.title,
        task.description,
        task.contextLabel,
        task.assigneeLabel,
        task.assigneeEmail,
        task.priority,
        task.status,
        sourceLabel(task.sourceType)
      ]
        .join(' ')
        .toLowerCase();

      return haystack.indexOf(query) >= 0;
    });
  }

  function activeSnapshotPollMs() {
    return document.visibilityState === 'hidden' ? BACKGROUND_POLL_MS : SNAPSHOT_POLL_MS;
  }

  function scheduleSnapshotRefresh(delay) {
    window.clearTimeout(refreshScheduleTimer);
    refreshScheduleTimer = window.setTimeout(function () {
      refreshSnapshots();
    }, typeof delay === 'number' ? delay : activeSnapshotPollMs());
  }

  function scheduleRouteSync(delay) {
    window.clearTimeout(routeSyncTimer);
    routeSyncTimer = window.setTimeout(function () {
      syncRouteView();
    }, typeof delay === 'number' ? delay : ROUTE_SYNC_DEBOUNCE_MS);
  }

  function createAssignmentEntry(task, sourceType, contextLabel) {
    var assignee = normalizeAssignee(task);
    return {
      id: String(task.id),
      taskId: String(task.id),
      sourceType: sourceType,
      contextLabel: normalizeContext(task, contextLabel),
      taskLabel: normalizeLabel(task),
      assigneeValue: assignee.value,
      assigneeName: assignee.name,
      assigneeEmail: assignee.email,
      assigneeMode: assignee.mode,
      updatedAt: String(task.updatedAt || task.startDateTime || task.createdAt || '')
    };
  }

  function normalizePath(pathname) {
    var value = String(pathname || '/');
    if (value.length > 1 && value.charAt(value.length - 1) === '/') {
      value = value.slice(0, -1);
    }
    return value || '/';
  }

  function isOpsRoute(pathname) {
    var value = normalizePath(pathname);
    return value === '/tasks' || value === '/tasks-daily-routines' || value === '/live-ops';
  }

  function isDashboardRoute(pathname) {
    var value = normalizePath(pathname);
    return value === '/' || value === '/index';
  }

  function buildOpsDashboardUrl(pathname) {
    var url = new URL(window.location.origin + '/');
    url.searchParams.set('trygc-live-ops', '1');
    if (pathname) {
      url.searchParams.set('ops-from', normalizePath(pathname));
    }
    return url.pathname + url.search + url.hash;
  }

  function shouldOpenOpsFromUrl() {
    try {
      return new URLSearchParams(window.location.search).get('trygc-live-ops') === '1';
    } catch (err) {
      return false;
    }
  }

  function getOpsSourcePathFromUrl() {
    try {
      return normalizePath(new URLSearchParams(window.location.search).get('ops-from') || '/');
    } catch (err) {
      return '/';
    }
  }

  function consumeOpsQuery() {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete('trygc-live-ops');
      url.searchParams.delete('ops-from');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    } catch (err) {}
  }

  function forceOpsDocumentNavigation(pathname) {
    var targetPath = normalizePath(pathname || window.location.pathname);
    if (!isOpsRoute(targetPath)) return;
    window.location.replace(buildOpsDashboardUrl(targetPath));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'person';
  }

  function looksLikePerson(task) {
    var assignee = normalizeAssignee(task);
    if (assignee.mode === 'person') return true;
    if (assignee.email) return true;
    if (!assignee.value) return false;
    if (/team/i.test(assignee.value)) return false;
    return true;
  }

  function buildOpsTask(task, sourceType, contextLabel) {
    var assignee = normalizeAssignee(task);
    return {
      id: String(task.id),
      key: String(task.id),
      title: normalizeLabel(task),
      description: String(task.description || task.notes || ''),
      contextLabel: normalizeContext(task, contextLabel),
      status: String(task.status || 'Pending'),
      priority: String(task.priority || 'Medium'),
      assigneeKey: assignee.email || slugify(assignee.name || assignee.value),
      assigneeLabel: assignee.name || assignee.email || assignee.value || 'Unassigned',
      assigneeEmail: assignee.email,
      sourceType: sourceType,
      dueDate: String(task.dueDate || ''),
      updatedAt: String(task.updatedAt || task.startDateTime || task.createdAt || ''),
      raw: task
    };
  }

  function collectOpsTasks(workspace, community) {
    var rows = [];

    function add(task, sourceType, contextLabel) {
      if (!task || task.id === undefined || task.id === null) return;
      if (!looksLikePerson(task)) return;
      rows.push(buildOpsTask(task, sourceType, contextLabel));
    }

    var tasks = (workspace && workspace.tasks) || [];
    tasks.forEach(function (task) {
      add(task, 'workspace', task.campaign || 'Assigned Tasks');
    });

    var standalone = (workspace && workspace.standaloneTasks) || [];
    standalone.forEach(function (task) {
      add(task, 'standalone', task.campaign || 'Standalone Tasks');
    });

    var campaigns = (workspace && workspace.opsCampaigns) || [];
    campaigns.forEach(function (campaign) {
      var teamPlans = campaign && campaign.teamPlans ? campaign.teamPlans : [];
      teamPlans.forEach(function (plan) {
        var tasksInPlan = plan && plan.tasks ? plan.tasks : [];
        tasksInPlan.forEach(function (task) {
          add(task, 'campaign', (campaign && campaign.name) || 'Campaign');
        });
      });
    });

    var countries = community && community.data && community.data.countries ? community.data.countries : [];
    countries.forEach(function (country) {
      var countryTasks = country && country.tasks ? country.tasks : [];
      countryTasks.forEach(function (task) {
        add(task, 'community', country.name || 'Community');
      });
    });

    rows.sort(function (a, b) {
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });

    return rows;
  }

  function collectAssigneeStats(tasks) {
    var map = new Map();
    tasks.forEach(function (task) {
      if (!task.assigneeKey) return;
      var existing = map.get(task.assigneeKey) || {
        key: task.assigneeKey,
        label: task.assigneeLabel,
        email: task.assigneeEmail,
        count: 0,
        tasks: []
      };
      existing.count += 1;
      existing.tasks.push(task);
      map.set(task.assigneeKey, existing);
    });

    return Array.from(map.values()).sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });
  }

  function dedupePresenceUsers(channel) {
    if (!channel || typeof channel.presenceState !== 'function') return [];
    var state = channel.presenceState() || {};
    var flat = [];
    Object.keys(state).forEach(function (key) {
      var entries = state[key] || [];
      entries.forEach(function (entry) {
        if (entry && entry.email) flat.push(entry);
      });
    });

    var deduped = new Map();
    flat.forEach(function (entry) {
      var email = String(entry.email || '').toLowerCase();
      if (!email) return;
      deduped.set(email, {
        email: email,
        name: String(entry.name || entry.email || ''),
        page: String(entry.page || ''),
        onlineAt: String(entry.online_at || '')
      });
    });

    return Array.from(deduped.values()).sort(function (a, b) {
      return a.email.localeCompare(b.email);
    });
  }

  function collectAssignments(workspace, community) {
    var map = new Map();

    function add(task, sourceType, contextLabel) {
      if (!task || task.id === undefined || task.id === null) return;
      var entry = createAssignmentEntry(task, sourceType, contextLabel);
      map.set(entry.id, entry);
    }

    var tasks = (workspace && workspace.tasks) || [];
    tasks.forEach(function (task) {
      add(task, 'workspace', task.campaign || 'Assigned Tasks');
    });

    var standalone = (workspace && workspace.standaloneTasks) || [];
    standalone.forEach(function (task) {
      add(task, 'standalone', task.campaign || 'Standalone Tasks');
    });

    var campaigns = (workspace && workspace.opsCampaigns) || [];
    campaigns.forEach(function (campaign) {
      var teamPlans = campaign && campaign.teamPlans ? campaign.teamPlans : [];
      teamPlans.forEach(function (plan) {
        var tasksInPlan = plan && plan.tasks ? plan.tasks : [];
        tasksInPlan.forEach(function (task) {
          add(task, 'campaign', (campaign && campaign.name) || 'Campaign');
        });
      });
    });

    var countries = community && community.data && community.data.countries ? community.data.countries : [];
    countries.forEach(function (country) {
      var countryTasks = country && country.tasks ? country.tasks : [];
      countryTasks.forEach(function (task) {
        task.country = country.name || country.id || 'Community';
        add(task, 'community', country.name || 'Community');
      });
    });

    return map;
  }

  function injectOpsStyles() {
    if (document.getElementById('trygc-ops-styles')) return;
    var style = document.createElement('style');
    style.id = 'trygc-ops-styles';
    style.textContent = [
      '[data-trygc-ops-panel-shell]{margin-top:18px;}',
      '[data-trygc-ops-panel-shell][hidden]{display:none !important;}',
      '.trygc-ops-inline-shell{overflow:hidden;}',
      '.trygc-ops-shell{padding:0;background:transparent;color:inherit;}',
      '.trygc-ops-wrap{max-width:none;margin:0;display:flex;flex-direction:column;gap:18px;}',
      '.trygc-ops-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;}',
      '.trygc-ops-head > *,.trygc-ops-grid > *,.trygc-ops-stats > *,.trygc-ops-widget-head > *{min-width:0;}',
      '.trygc-ops-head-copy{flex:1 1 32rem;min-width:0;}',
      '.trygc-ops-title-text{max-width:42rem;overflow-wrap:anywhere;word-break:break-word;}',
      '.trygc-ops-copy-text{max-width:48rem;overflow-wrap:anywhere;}',
      '.trygc-ops-head-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.trygc-ops-head-actions button,.trygc-ops-widget-head button{max-width:100%;}',
      '.trygc-ops-button-label{display:block;white-space:nowrap;}',
      '.trygc-ops-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;}',
      '.trygc-ops-grid{display:grid;grid-template-columns:minmax(300px,340px) minmax(0,1fr);gap:16px;align-items:start;}',
      '.trygc-ops-assignees{display:flex;flex-direction:column;gap:10px;}',
      '.trygc-ops-assignee{width:100%;text-align:left;cursor:pointer;}',
      '.trygc-ops-assignee:hover,.trygc-ops-task:hover{transform:translateY(-1px);}',
      '.trygc-ops-row{display:flex;justify-content:space-between;gap:12px;align-items:center;}',
      '.trygc-ops-users{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}',
      '.trygc-ops-dot{width:8px;height:8px;border-radius:999px;background:#10b981;box-shadow:0 0 0 6px rgba(16,185,129,.12);}',
      '.trygc-ops-tasks{display:flex;flex-direction:column;gap:12px;}',
      '.trygc-ops-task{width:100%;text-align:left;cursor:pointer;}',
      '.trygc-ops-task-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}',
      '.trygc-ops-widget{margin-top:14px;border-top:1px solid rgba(17,24,39,.08);padding-top:14px;}',
      '.dark .trygc-ops-widget{border-top-color:rgba(255,255,255,.08);}',
      '.trygc-ops-widget-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;}',
      '.trygc-ops-widget-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px;}',
      '.trygc-ops-widget-users{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}',
      '@media (max-width: 980px){.trygc-ops-stats{grid-template-columns:repeat(2,minmax(0,1fr));}.trygc-ops-grid{grid-template-columns:minmax(0,1fr);}}',
      '@media (max-width: 640px){.trygc-ops-stats,.trygc-ops-widget-stats{grid-template-columns:minmax(0,1fr);}.trygc-ops-head{gap:12px;}.trygc-ops-head-actions{width:100%;}.trygc-ops-head-actions button,.trygc-ops-widget-head button{flex:1 1 auto;justify-content:center;}.trygc-ops-button-label{white-space:normal;line-height:1.25;text-align:center;}}'
    ].join('');
    document.head.appendChild(style);
  }

  function patchNavLabels() {
    var candidates = document.querySelectorAll('a,button,span,div');
    candidates.forEach(function (node) {
      if (!node || node.children.length > 2) return;
      var text = String(node.textContent || '').trim();
      if (text === 'All Tasks' || text === 'Tasks & Daily Routines') {
        node.textContent = 'Live Ops';
      }
    });
  }

  function findLiveUsersWidget() {
    if (opsPageState.widget && document.body && document.body.contains(opsPageState.widget)) {
      return opsPageState.widget;
    }

    var labels = document.querySelectorAll('h1,h2,h3,h4,p,span,div');
    var markers = ['live users', 'active users', 'live active users'];
    var i;
    for (i = 0; i < labels.length; i += 1) {
      var node = labels[i];
      if (!node || !node.textContent) continue;
      if (node.closest('[data-trygc-ops-panel-shell],[data-trygc-ops-widget]')) continue;
      var text = String(node.textContent || '').trim().toLowerCase();
      if (!markers.some(function (marker) { return text === marker; })) continue;
      var container = node.closest('.app-panel, .app-surface-card, article, section, [class*="rounded"]');
      if (!container) continue;
      var containerText = String(container.textContent || '').toLowerCase();
      if (containerText.indexOf('online now') === -1 &&
          containerText.indexOf('connecting to presence') === -1 &&
          containerText.indexOf('no other users online') === -1 &&
          containerText.indexOf('active now') === -1) {
        continue;
      }
      container.setAttribute('data-trygc-ops-anchor', 'true');
      return container;
    }
    return null;
  }

  function ensureOpsPanel(container) {
    if (!container || !container.parentNode) return null;
    injectOpsStyles();

    var panel = container.nextElementSibling;
    if (!panel || panel.getAttribute('data-trygc-ops-panel-shell') !== 'true') {
      panel = document.createElement('section');
      panel.setAttribute('data-trygc-ops-panel-shell', 'true');
      panel.hidden = true;
      panel.innerHTML = '<div class="trygc-ops-inline-shell"><div data-trygc-ops-host="inline"></div></div>';
      container.parentNode.insertBefore(panel, container.nextSibling);
    }

    opsPageState.panel = panel;
    opsPageState.host = panel.querySelector('[data-trygc-ops-host]');
    return opsPageState.host;
  }

  function openOpsPanel(sourcePath) {
    var container = findLiveUsersWidget();
    if (!container) return false;
    var host = ensureOpsPanel(container);
    if (!host || !opsPageState.panel) return false;
    opsPageState.open = true;
    opsPageState.sourcePath = normalizePath(sourcePath || window.location.pathname || '/');
    opsPageState.panel.hidden = false;
    renderOpsPage();
    window.setTimeout(function () {
      try {
        opsPageState.panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } catch (err) {}
    }, 32);
    return true;
  }

  function closeOpsPanel() {
    if (opsPageState.panel) {
      opsPageState.panel.hidden = true;
    }
    opsPageState.open = false;
  }

  function patchDashboardWidget() {
    var container = findLiveUsersWidget();
    if (!container) {
      opsPageState.widget = null;
      widgetSignature = '';
      panelSignature = '';
      if (opsPageState.panel && opsPageState.panel.parentNode) {
        opsPageState.panel.hidden = true;
      }
      return;
    }
    injectOpsStyles();
    opsPageState.widget = container;
    ensureOpsPanel(container);

    var tasks = collectOpsTasks(latestWorkspaceSnapshot || {}, latestCommunitySnapshot || {});
    var assignees = collectAssigneeStats(tasks);
    var widget = container.querySelector('[data-trygc-ops-widget]');
    if (!widget) {
      widget = document.createElement('div');
      widget.setAttribute('data-trygc-ops-widget', 'true');
      widget.className = 'trygc-ops-widget';
      container.appendChild(widget);
    }

    var previewUsers = liveUsers.slice(0, 4);
    var snapshotLabel = formatSnapshotStamp(lastSnapshotStamp);
    var markup =
      '<div class="trygc-ops-widget-head">' +
      '  <div class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Live Ops</div>' +
      '  <button type="button" class="' + (opsPageState.open
          ? 'flex items-center gap-2 px-4 py-2 bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 rounded-2xl font-black text-[11px] uppercase tracking-wide hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-all'
          : 'app-accent-button flex items-center gap-2 px-4 py-2 rounded-2xl font-black text-[11px] uppercase tracking-wide transition-all shadow-xl') + '" data-open-ops-panel="true"><span class="trygc-ops-button-label">' + (opsPageState.open ? 'Hide task board' : 'Open task board') + '</span></button>' +
      '</div>' +
      '<div class="trygc-ops-widget-stats">' +
      '  <div class="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-3 py-3"><div class="text-2xl font-black text-zinc-900 dark:text-zinc-100">' + liveUsers.length + '</div><div class="mt-1 text-[10px] font-black uppercase tracking-wider text-zinc-400">Active now</div></div>' +
      '  <div class="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-3 py-3"><div class="text-2xl font-black text-zinc-900 dark:text-zinc-100">' + tasks.length + '</div><div class="mt-1 text-[10px] font-black uppercase tracking-wider text-zinc-400">Assigned tasks</div></div>' +
      '  <div class="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-3 py-3"><div class="text-2xl font-black text-zinc-900 dark:text-zinc-100">' + assignees.length + '</div><div class="mt-1 text-[10px] font-black uppercase tracking-wider text-zinc-400">Owners</div></div>' +
      '</div>' +
      '<div class="mt-3 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Latest sync: ' + escapeHtml(snapshotLabel) + '</div>' +
      (previewUsers.length
        ? '<div class="trygc-ops-widget-users">' + previewUsers.map(function (user) {
            return '<span class="inline-flex items-center gap-2 rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 text-[11px] font-bold text-zinc-700 dark:text-zinc-300"><span class="trygc-ops-dot"></span>' + escapeHtml(user.name || user.email) + (user.page ? '<span class="opacity-60">· ' + escapeHtml(normalizePath(user.page)) + '</span>' : '') + '</span>';
          }).join('') + '</div>'
        : '<div class="mt-3 text-xs font-medium text-zinc-500 dark:text-zinc-400">Presence updates will appear here as users refresh into the latest build.</div>');

    var nextSignature = [
      opsPageState.open ? '1' : '0',
      tasks.length,
      assignees.length,
      snapshotLabel,
      liveUsers.map(function (user) { return user.email + ':' + normalizePath(user.page); }).join('|')
    ].join('::');

    if (nextSignature !== widgetSignature || widget.innerHTML !== markup) {
      widget.innerHTML = markup;
      widgetSignature = nextSignature;
    }

    widget.onclick = function (event) {
      var button = event.target && event.target.closest ? event.target.closest('[data-open-ops-panel="true"]') : null;
      if (!button) return;
      if (opsPageState.open) {
        closeOpsPanel();
      } else {
        openOpsPanel(window.location.pathname);
      }
      patchDashboardWidget();
    };
  }

  function renderOpsPage() {
    patchDashboardWidget();
    if (!opsPageState.open || !opsPageState.widget) return;
    ensureOpsPanel(opsPageState.widget);
    if (!opsPageState.host || !opsPageState.panel) return;
    opsPageState.panel.hidden = false;

    var tasks = collectOpsTasks(latestWorkspaceSnapshot || {}, latestCommunitySnapshot || {});
    var filteredTasks = filterOpsTasks(tasks);
    var assignees = collectAssigneeStats(filteredTasks);
    var activeCount = liveUsers.length;
    var selectedAssignee = opsPageState.selectedAssignee;

    if (!selectedAssignee || !assignees.some(function (item) { return item.key === selectedAssignee; })) {
      selectedAssignee = assignees.length ? assignees[0].key : '';
      opsPageState.selectedAssignee = selectedAssignee;
    }

    var selectedGroup = assignees.find(function (item) { return item.key === selectedAssignee; }) || null;
    var selectedTasks = selectedGroup ? selectedGroup.tasks : [];
    var totalAssigned = filteredTasks.length;
    var peopleCount = assignees.length;
    var pathLabel = opsPageState.sourcePath === '/tasks-daily-routines'
      ? 'Tasks & Daily Routines'
      : opsPageState.sourcePath === '/tasks'
        ? 'All Tasks'
        : 'Dashboard';
    var snapshotLabel = formatSnapshotStamp(lastSnapshotStamp);
    var normalizedStatusFilter = normalizeOpsFilter(opsPageState.statusFilter);
    var normalizedSourceFilter = normalizeOpsFilter(opsPageState.sourceFilter);
    var markup =
      '<div class="trygc-ops-shell app-panel rounded-[var(--app-card-radius)] border p-5 md:p-6">' +
      '  <div class="trygc-ops-wrap">' +
      '    <div class="trygc-ops-head">' +
      '      <div class="trygc-ops-head-copy">' +
      '        <p class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Live Ops</p>' +
      '        <h2 class="trygc-ops-title-text mt-2 text-xl md:text-2xl xl:text-3xl font-black leading-tight tracking-tight text-zinc-900 dark:text-zinc-100">Assigned work linked to the dashboard live-users widget.</h2>' +
      '        <p class="trygc-ops-copy-text mt-2 text-sm font-medium leading-relaxed text-zinc-500 dark:text-zinc-400">This section sits inside the main build, directly under the existing Live Active Users card. Routes like ' + escapeHtml(pathLabel) + ' now deep-link here instead of opening a detached page.</p>' +
      '      </div>' +
      '      <div class="trygc-ops-head-actions">' +
      '        <button type="button" class="app-accent-button flex items-center gap-2 px-4 py-2.5 rounded-2xl font-black text-sm transition-all shadow-xl" data-ops-action="refresh"><span class="trygc-ops-button-label">Refresh Live Data</span></button>' +
      '        <button type="button" class="flex items-center gap-2 px-4 py-2.5 bg-zinc-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 rounded-2xl font-black text-sm hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-all" data-ops-action="close"><span class="trygc-ops-button-label">Collapse</span></button>' +
      '      </div>' +
      '    </div>' +
      '    <div class="app-panel rounded-[var(--app-card-radius)] border p-4 md:p-5">' +
      '      <div class="trygc-ops-filter-grid">' +
      '        <label class="trygc-ops-filter-field"><span class="trygc-ops-filter-label">Search</span><input data-ops-input="search" value="' + escapeHtml(opsPageState.searchQuery) + '" class="trygc-ops-filter-input" type="text" placeholder="Search task, owner, status, or context" /></label>' +
      '        <label class="trygc-ops-filter-field"><span class="trygc-ops-filter-label">Status</span><select data-ops-input="status" class="trygc-ops-filter-input"><option value="all"' + (normalizedStatusFilter === 'all' ? ' selected' : '') + '>All statuses</option><option value="pending"' + (normalizedStatusFilter === 'pending' ? ' selected' : '') + '>Pending</option><option value="in progress"' + (normalizedStatusFilter === 'in progress' ? ' selected' : '') + '>In progress</option><option value="blocked"' + (normalizedStatusFilter === 'blocked' ? ' selected' : '') + '>Blocked</option><option value="done"' + (normalizedStatusFilter === 'done' ? ' selected' : '') + '>Done</option></select></label>' +
      '        <label class="trygc-ops-filter-field"><span class="trygc-ops-filter-label">Source</span><select data-ops-input="source" class="trygc-ops-filter-input"><option value="all"' + (normalizedSourceFilter === 'all' ? ' selected' : '') + '>All sources</option><option value="workspace"' + (normalizedSourceFilter === 'workspace' ? ' selected' : '') + '>Workspace</option><option value="campaign"' + (normalizedSourceFilter === 'campaign' ? ' selected' : '') + '>Campaign</option><option value="community"' + (normalizedSourceFilter === 'community' ? ' selected' : '') + '>Community</option><option value="standalone"' + (normalizedSourceFilter === 'standalone' ? ' selected' : '') + '>Standalone</option></select></label>' +
      '      </div>' +
      '      <div class="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11px] font-medium text-zinc-500 dark:text-zinc-400"><span>Latest sync: ' + escapeHtml(snapshotLabel) + '</span><span>' + escapeHtml(String(totalAssigned)) + ' matching tasks across ' + escapeHtml(String(peopleCount)) + ' owners</span></div>' +
      '    </div>' +
      '    <div class="trygc-ops-stats">' +
      '      <div class="app-panel rounded-[var(--app-card-radius)] border p-5"><div class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Live Active Users</div><div class="mt-3 text-3xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">' + activeCount + '</div><div class="mt-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">Realtime presence across the tool</div></div>' +
      '      <div class="app-panel rounded-[var(--app-card-radius)] border p-5"><div class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Filtered Tasks</div><div class="mt-3 text-3xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">' + totalAssigned + '</div><div class="mt-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">Person-only assignments after current filters are applied</div></div>' +
      '      <div class="app-panel rounded-[var(--app-card-radius)] border p-5"><div class="text-[10px] font-black uppercase tracking-widest text-zinc-400">People With Assignments</div><div class="mt-3 text-3xl font-black tracking-tight text-zinc-900 dark:text-zinc-100">' + peopleCount + '</div><div class="mt-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">' + escapeHtml(selectedGroup ? selectedGroup.label + ' · ' + selectedGroup.count + ' tasks selected' : 'Choose an owner from the left rail') + '</div></div>' +
      '    </div>' +
      '    <div class="app-panel rounded-[var(--app-card-radius)] border p-5">' +
      '      <div class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Live Users</div>' +
      (liveUsers.length
        ? '<div class="trygc-ops-users">' + liveUsers.map(function (user) {
            return '<span class="inline-flex items-center gap-2 rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1.5 text-xs font-bold text-zinc-700 dark:text-zinc-300"><span class="trygc-ops-dot"></span>' + escapeHtml(user.name || user.email) + (user.page ? '<span class="opacity-60">· ' + escapeHtml(normalizePath(user.page)) + '</span>' : '') + '</span>';
          }).join('') + '</div>'
        : '<div class="mt-4 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-800 px-4 py-5 text-sm font-medium text-zinc-500 dark:text-zinc-400 text-center">No live users detected yet. A refresh after the new deploy will make active sessions appear here.</div>') +
      '    </div>' +
      '    <div class="trygc-ops-grid">' +
      '      <div class="app-panel rounded-[var(--app-card-radius)] border p-5">' +
      '        <div class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Assigned People</div>' +
      (assignees.length
        ? '<div class="trygc-ops-assignees">' + assignees.map(function (person) {
            return '' +
              '<button type="button" class="trygc-ops-assignee rounded-2xl border px-4 py-3 transition-all ' + (person.key === selectedAssignee
                ? 'border-[rgba(var(--app-primary-rgb),0.12)] bg-zinc-50 dark:bg-zinc-900'
                : 'border-zinc-200 dark:border-zinc-800 hover:border-[rgba(var(--app-primary-rgb),0.08)] hover:bg-zinc-50 dark:hover:bg-zinc-900') + '" data-assignee-key="' + escapeHtml(person.key) + '">' +
              '  <div class="trygc-ops-row"><div><div class="text-sm font-bold text-zinc-800 dark:text-zinc-100">' + escapeHtml(person.label) + '</div>' + (person.email ? '<div class="mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400 break-all">' + escapeHtml(person.email) + '</div>' : '') + '</div><span class="inline-flex items-center justify-center min-w-[2.5rem] rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1 text-[11px] font-black text-zinc-700 dark:text-zinc-300">' + person.count + '</span></div>' +
              '</button>';
          }).join('') + '</div>'
        : '<div class="mt-4 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-800 px-4 py-5 text-sm font-medium text-zinc-500 dark:text-zinc-400 text-center">No person-assigned tasks were found in the live workspace.</div>') +
      '      </div>' +
      '      <div class="app-panel rounded-[var(--app-card-radius)] border p-5">' +
      '        <div class="text-[10px] font-black uppercase tracking-widest text-zinc-400">Clickable Tasks</div>' +
      (selectedTasks.length
        ? '<div class="trygc-ops-tasks">' + selectedTasks.map(function (task) {
            var isOpen = opsPageState.selectedTaskId === task.id;
            var tone = statusTone(task.status);
            return '' +
              '<button type="button" class="trygc-ops-task rounded-2xl border px-4 py-4 transition-all ' + (isOpen
                ? 'border-[rgba(var(--app-primary-rgb),0.12)] bg-zinc-50 dark:bg-zinc-900'
                : 'border-zinc-200 dark:border-zinc-800 hover:border-[rgba(var(--app-primary-rgb),0.08)] hover:bg-zinc-50 dark:hover:bg-zinc-900') + '" data-task-id="' + escapeHtml(task.id) + '">' +
              '  <div class="text-sm font-bold leading-6 text-zinc-800 dark:text-zinc-100">' + escapeHtml(task.title) + '</div>' +
              '  <div class="trygc-ops-task-meta">' +
              '    <span class="text-[10px] font-black px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">' + escapeHtml(task.contextLabel) + '</span>' +
              '    <span class="text-[10px] font-black px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 uppercase tracking-wide" data-status-tone="' + escapeHtml(tone) + '">' + escapeHtml(task.status) + '</span>' +
              '    <span class="text-[10px] font-black px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">' + escapeHtml(task.priority) + '</span>' +
              '    <span class="text-[10px] font-black px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 uppercase tracking-wide">' + escapeHtml(sourceLabel(task.sourceType)) + '</span>' +
              '  </div>' +
              (isOpen ? '<div class="mt-3 border-t border-zinc-200 dark:border-zinc-800 pt-3 text-sm font-medium leading-relaxed text-zinc-500 dark:text-zinc-400">' + escapeHtml(task.description || 'No extra notes for this task yet.') + '</div>' : '') +
              '</button>';
          }).join('') + '</div>'
        : '<div class="mt-4 rounded-2xl border border-dashed border-zinc-200 dark:border-zinc-800 px-4 py-5 text-sm font-medium text-zinc-500 dark:text-zinc-400 text-center">Select a person to inspect their assigned tasks.</div>') +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    if (markup !== panelSignature || opsPageState.host.innerHTML !== markup) {
      opsPageState.host.innerHTML = markup;
      panelSignature = markup;
    }

    opsPageState.host.onclick = function (event) {
      var action = event.target && event.target.closest ? event.target.closest('[data-ops-action],[data-assignee-key],[data-task-id]') : null;
      if (!action) return;

      if (action.getAttribute('data-ops-action') === 'refresh') {
        refreshSnapshots();
        return;
      }

      if (action.getAttribute('data-ops-action') === 'close') {
        closeOpsPanel();
        patchDashboardWidget();
        return;
      }

      var assigneeKey = action.getAttribute('data-assignee-key');
      if (assigneeKey) {
        opsPageState.selectedAssignee = assigneeKey;
        opsPageState.selectedTaskId = '';
        renderOpsPage();
        return;
      }

      var taskId = action.getAttribute('data-task-id');
      if (taskId) {
        opsPageState.selectedTaskId = opsPageState.selectedTaskId === taskId ? '' : taskId;
        renderOpsPage();
      }
    };

    opsPageState.host.oninput = function (event) {
      var input = event.target && event.target.closest ? event.target.closest('[data-ops-input="search"]') : null;
      if (!input) return;
      opsPageState.searchQuery = input.value || '';
      opsPageState.selectedTaskId = '';
      renderOpsPage();
    };

    opsPageState.host.onchange = function (event) {
      var input = event.target && event.target.closest ? event.target.closest('[data-ops-input]') : null;
      if (!input) return;
      if (input.getAttribute('data-ops-input') === 'status') {
        opsPageState.statusFilter = input.value || 'all';
      } else if (input.getAttribute('data-ops-input') === 'source') {
        opsPageState.sourceFilter = input.value || 'all';
      } else {
        return;
      }
      opsPageState.selectedTaskId = '';
      renderOpsPage();
    };
  }

  function syncRouteView() {
    patchNavLabels();
    patchDashboardWidget();

    if (isOpsRoute(window.location.pathname)) {
      forceOpsDocumentNavigation(window.location.pathname);
      return;
    }

    if (shouldOpenOpsFromUrl()) {
      if (openOpsPanel(getOpsSourcePathFromUrl())) {
        consumeOpsQuery();
      }
    }

    if (opsPageState.open && (!opsPageState.panel || !document.body.contains(opsPageState.panel))) {
      opsPageState.open = false;
      opsPageState.panel = null;
      opsPageState.host = null;
    }
  }

  function markAlert(id) {
    recentAlertIds.add(id);
    window.setTimeout(function () {
      recentAlertIds.delete(id);
    }, 45000);
  }

  function dispatchAlert(title, body, dedupeId) {
    if (dedupeId && recentAlertIds.has(dedupeId)) return;
    if (dedupeId) markAlert(dedupeId);
    playSound();
    showToast(title, body);
    showBrowserNotif(title, body);
  }

  function notificationTimestamp(item) {
    var candidates = [
      item && item.receivedAt,
      item && item.createdAt,
      item && item.updatedAt,
      item && item.timestamp,
      item && item.time,
      item && item.date
    ];
    var i;
    for (i = 0; i < candidates.length; i += 1) {
      var raw = candidates[i];
      if (!raw) continue;
      var time = new Date(raw).getTime();
      if (!Number.isNaN(time)) return time;
    }
    if (item && typeof item.id === 'number') return item.id;
    return 0;
  }

  function isPinnedUpdateNotification(item) {
    if (!item) return false;
    if (item.pinned === true || item.isPinned === true) return true;
    var bucket = [
      item.type,
      item.category,
      item.notificationType,
      item.kind,
      item.title,
      item.taskName
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return bucket.indexOf('update') >= 0;
  }

  function sortNotifications(list) {
    return list
      .map(function (item) {
        var clone = Object.assign({}, item);
        clone.pinned = isPinnedUpdateNotification(item);
        clone.read = !!item.read;
        return clone;
      })
      .sort(function (a, b) {
        var aPinned = a.pinned ? 1 : 0;
        var bPinned = b.pinned ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        if (a.read !== b.read) return a.read ? 1 : -1;
        return notificationTimestamp(b) - notificationTimestamp(a);
      });
  }

  function normalizeStoredNotifications(originalSetItem) {
    if (notificationSortLock) return;
    try {
      var raw = window.localStorage.getItem(NOTIF_KEY);
      if (!raw) return;
      var list = JSON.parse(raw);
      if (!Array.isArray(list)) return;
      var sorted = sortNotifications(list);
      if (JSON.stringify(sorted) === JSON.stringify(list)) return;
      notificationSortLock = true;
      originalSetItem(NOTIF_KEY, JSON.stringify(sorted));
    } catch (err) {
    } finally {
      notificationSortLock = false;
    }
  }

  function assignmentBody(entry, verb) {
    var who = entry.assigneeName || entry.assigneeEmail || entry.assigneeValue || 'someone';
    return entry.taskLabel + ' -> ' + who + ' [' + entry.contextLabel + ']';
  }

  function notifyAssignmentChanges(nextAssignments) {
    if (!hasAssignmentBaseline) {
      currentAssignments = nextAssignments;
      hasAssignmentBaseline = true;
      return;
    }

    nextAssignments.forEach(function (nextEntry, taskId) {
      var prevEntry = currentAssignments.get(taskId);
      var hadAssignee = !!(prevEntry && prevEntry.assigneeValue);
      var hasAssignee = !!nextEntry.assigneeValue;
      var changedAssignee =
        prevEntry &&
        (prevEntry.assigneeValue !== nextEntry.assigneeValue ||
          prevEntry.assigneeMode !== nextEntry.assigneeMode ||
          prevEntry.contextLabel !== nextEntry.contextLabel);

      if (!prevEntry && hasAssignee) {
        dispatchAlert('New Assignment', assignmentBody(nextEntry, 'assigned'), 'assign:' + taskId + ':' + nextEntry.assigneeValue);
      } else if (hadAssignee && hasAssignee && changedAssignee) {
        dispatchAlert('Task Reassigned', assignmentBody(nextEntry, 'reassigned'), 'reassign:' + taskId + ':' + nextEntry.assigneeValue);
      } else if (!hadAssignee && hasAssignee) {
        dispatchAlert('Task Assigned', assignmentBody(nextEntry, 'assigned'), 'assign:' + taskId + ':' + nextEntry.assigneeValue);
      }
    });

    currentAssignments = nextAssignments;
  }

  function checkLocalNotifications() {
    try {
      var raw = window.localStorage.getItem(NOTIF_KEY);
      if (!raw) return;
      var list = JSON.parse(raw);
      if (!Array.isArray(list)) return;

      list.forEach(function (item) {
        if (!item || item.id === undefined || item.id === null) return;
        var id = String(item.id);
        if (seenNotifIds.has(id)) return;
        seenNotifIds.add(id);
        if (item.read) return;

        var campaign = item.taskName || item.title || 'Assignment Update';
        var taskTitle = item.taskDescription || item.description || '';
        var assignee = item.assignedToName || item.assignedToEmail || item.assignedTo || '';
        var message = taskTitle
          ? taskTitle + (assignee ? ' -> ' + assignee : '') + ' • ' + campaign
          : assignee
            ? campaign + ' -> ' + assignee
            : campaign;
        dispatchAlert('Assignment Update', message, 'notif:' + id);
      });
    } catch (err) {}
  }

  function seedSeenNotifications() {
    try {
      var raw = window.localStorage.getItem(NOTIF_KEY);
      if (!raw) return;
      var list = JSON.parse(raw);
      if (!Array.isArray(list)) return;
      list.forEach(function (item) {
        if (item && item.id !== undefined && item.id !== null) {
          seenNotifIds.add(String(item.id));
        }
      });
    } catch (err) {}
  }

  function fetchJson(url) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeoutId = controller
      ? window.setTimeout(function () {
          try {
            controller.abort();
          } catch (err) {}
        }, FETCH_TIMEOUT_MS)
      : null;

    return window.fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
      headers: {
        Authorization: 'Bearer ' + PUBLIC_ANON_KEY
      }
    }).then(function (response) {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error('Request failed: ' + response.status);
      }
      return response.json();
    }).catch(function (error) {
      if (timeoutId) window.clearTimeout(timeoutId);
      throw error;
    });
  }

  function refreshSnapshots() {
    startPresenceTracking();
    if (refreshInFlight) return Promise.resolve();
    refreshInFlight = true;

    return Promise.all([
      fetchJson(API_BASE + '/data').catch(function () {
        return null;
      }),
      fetchJson(API_BASE + '/community-team-data').catch(function () {
        return null;
      })
    ])
      .then(function (results) {
        var workspace = results[0] || latestWorkspaceSnapshot || {};
        var community = results[1] || latestCommunitySnapshot || {};
        latestWorkspaceSnapshot = workspace;
        latestCommunitySnapshot = community;
        lastSnapshotStamp = deriveSnapshotStamp(workspace, community);
        writeSnapshotCache(workspace, community);
        notifyAssignmentChanges(collectAssignments(workspace, community));
        renderOpsPage();
      })
      .catch(function () {})
      .finally(function () {
        refreshInFlight = false;
        scheduleSnapshotRefresh();
      });
  }

  function scheduleRefresh(delay) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(function () {
      refreshSnapshots();
    }, typeof delay === 'number' ? delay : 400);
  }

  function loadSupabaseClient() {
    if (supabaseClientPromise) return supabaseClientPromise;

    supabaseClientPromise = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
      .then(function (mod) {
        return mod.createClient('https://' + PROJECT_ID + '.supabase.co', PUBLIC_ANON_KEY, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false
          }
        });
      })
      .catch(function () {
        return null;
      });

    return supabaseClientPromise;
  }

  function startPresenceTracking() {
    var user = getCurrentUser();
    if (!user || !user.email) return;
    if (presenceChannel && presenceIdentity === user.email.toLowerCase()) return;

    loadSupabaseClient().then(function (client) {
      if (!client) return;

      if (presenceChannel) {
        try {
          client.removeChannel(presenceChannel);
        } catch (err) {}
        presenceChannel = null;
      }

      var key = user.email.toLowerCase();
      presenceIdentity = key;
      var channel = client.channel('platform-presence', {
        config: {
          presence: {
            key: key
          }
        }
      });

      function track() {
        channel.track({
          user_id: key,
          email: key,
          name: user.name || key,
          online_at: new Date().toISOString(),
          page: window.location.pathname
        }).catch(function () {});
      }

      function syncPresence() {
        liveUsers = dedupePresenceUsers(channel);
        renderOpsPage();
      }

      presenceChannel = channel;
      channel
        .on('presence', { event: 'sync' }, syncPresence)
        .on('presence', { event: 'join' }, syncPresence)
        .on('presence', { event: 'leave' }, syncPresence);
      channel.subscribe(function (status) {
        if (status === 'SUBSCRIBED') {
          track();
          syncPresence();
          window.clearInterval(heartbeatTimer);
          heartbeatTimer = window.setInterval(track, HEARTBEAT_MS);
        }
      });

      if (!presenceUnloadBound) {
        presenceUnloadBound = true;
        window.addEventListener('beforeunload', function () {
          try {
            if (presenceChannel) presenceChannel.untrack().catch(function () {});
          } catch (err) {}
        });
      }
    });
  }

  function installFetchHook() {
    if (!window.fetch || window.fetch.__trygcPatched) return;

    var originalFetch = window.fetch.bind(window);
    var wrapped = function (input, init) {
      var promise = originalFetch(input, init);
      promise
        .then(function (response) {
          var url = typeof input === 'string' ? input : input && input.url ? input.url : '';
          if (!response || !response.ok || !url) return;
          if (url.indexOf('/functions/v1/make-server-b626472b/') === -1) return;

          var method =
            (init && init.method) ||
            (typeof input !== 'string' && input && input.method) ||
            'GET';

          if (String(method).toUpperCase() === 'GET') return;
          scheduleRefresh(250);
        })
        .catch(function () {});
      return promise;
    };

    wrapped.__trygcPatched = true;
    window.fetch = wrapped;
  }

  function installStorageHook() {
    var originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    rawLocalSetItem = originalSetItem;
    window.localStorage.setItem = function (key, value) {
      if (key === NOTIF_KEY) {
        try {
          var parsed = JSON.parse(value);
          if (Array.isArray(parsed)) {
            value = JSON.stringify(sortNotifications(parsed));
          }
        } catch (err) {}
      }
      originalSetItem(key, value);
      if (key === NOTIF_KEY) {
        normalizeStoredNotifications(originalSetItem);
        window.setTimeout(checkLocalNotifications, 60);
      } else if (AUTH_KEYS.indexOf(key) >= 0) {
        window.setTimeout(startPresenceTracking, 120);
      }
    };

    window.addEventListener('storage', function (event) {
      if (event.key === NOTIF_KEY) {
        normalizeStoredNotifications(originalSetItem);
        window.setTimeout(checkLocalNotifications, 60);
      } else if (AUTH_KEYS.indexOf(event.key) >= 0) {
        window.setTimeout(startPresenceTracking, 120);
      }
    });
  }

  function installRouteObserver() {
    if (routeObserver || typeof MutationObserver !== 'function' || !document.body) return;

    routeObserver = new MutationObserver(function (mutations) {
      var changed = mutations.some(function (mutation) {
        return mutation.addedNodes.length || mutation.removedNodes.length;
      });
      if (changed) scheduleRouteSync();
    });

    routeObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function installOpsLinkInterceptor() {
    document.addEventListener(
      'click',
      function (event) {
        var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!anchor) return;
        var href = anchor.getAttribute('href') || '';
        var url;
        try {
          url = new URL(href, window.location.origin);
        } catch (err) {
          return;
        }
        if (!isOpsRoute(url.pathname)) return;
        event.preventDefault();
        window.location.href = buildOpsDashboardUrl(url.pathname);
      },
      true
    );
  }

  function installOpsHistoryInterceptor() {
    var originalPushState = window.history && window.history.pushState;
    if (typeof originalPushState === 'function') {
      window.history.pushState = function (state, title, url) {
        if (url) {
          try {
            var nextUrl = new URL(String(url), window.location.origin);
            if (isOpsRoute(nextUrl.pathname)) {
              window.location.assign(buildOpsDashboardUrl(nextUrl.pathname));
              return;
            }
          } catch (err) {}
        }
        var result = originalPushState.apply(this, arguments);
        scheduleRouteSync(0);
        return result;
      };
    }

    var originalReplaceState = window.history && window.history.replaceState;
    if (typeof originalReplaceState === 'function') {
      window.history.replaceState = function (state, title, url) {
        if (url) {
          try {
            var nextUrl = new URL(String(url), window.location.origin);
            if (isOpsRoute(nextUrl.pathname)) {
              window.location.replace(buildOpsDashboardUrl(nextUrl.pathname));
              return;
            }
          } catch (err) {}
        }
        var result = originalReplaceState.apply(this, arguments);
        scheduleRouteSync(0);
        return result;
      };
    }

    window.addEventListener('popstate', function () {
      scheduleRouteSync(0);
    }, true);
    forceOpsDocumentNavigation();
  }

  function init() {
    if (initialized) return;
    initialized = true;

    requestPermEarly();
    primeAudio();
    seedSeenNotifications();
    installStorageHook();
    installOpsLinkInterceptor();
    installOpsHistoryInterceptor();
    installFetchHook();
    installRouteObserver();
    startPresenceTracking();
    hydrateSnapshotsFromCache();
    syncRouteView();
    renderOpsPage();
    refreshSnapshots();
    if (rawLocalSetItem) normalizeStoredNotifications(rawLocalSetItem);
    checkLocalNotifications();

    window.setInterval(checkLocalNotifications, 4000);
    document.addEventListener('visibilitychange', function () {
      scheduleSnapshotRefresh(300);
      scheduleRouteSync(60);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
