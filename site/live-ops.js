(function () {
  'use strict';

  var PROJECT_ID = 'tabwjvmkvqhimlrszbwh';
  var FALLBACK_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ0YWJ3anZta3ZxaGltbHJzemJ3aCIsInJlZiI6InRhYndqdm1rdnFoaW1scnN6YndoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIyNjExNDgsImV4cCI6MjA4NzgzNzE0OH0.9PN-Fq77HSRXJ_ZrFGb_xZbKkn0KH5ZFNtAn6larwZM';
  var API_BASE = 'https://' + PROJECT_ID + '.supabase.co/functions/v1/make-server-b626472b';
  var AUTH_KEYS = ['supabase.auth.token', 'sb-' + PROJECT_ID + '-auth-token'];
  var HEARTBEAT_MS = 30000;
  var SNAPSHOT_POLL_MS = 8000;

  var root = document.getElementById('live-ops-app');
  if (!root) return;

  var state = {
    workspace: null,
    community: null,
    liveUsers: [],
    selectedAssignee: '',
    selectedTaskId: '',
    loading: true,
    error: ''
  };

  var refreshInFlight = false;
  var heartbeatTimer = null;
  var supabaseClientPromise = null;
  var presenceChannel = null;
  var presenceIdentity = '';

  function anonKey() {
    return FALLBACK_ANON_KEY;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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
          name: String(
            (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) ||
              user.name ||
              user.email ||
              ''
          )
        };
      }
    }
    return null;
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

  function slugify(value) {
    return (
      String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'person'
    );
  }

  function looksLikePerson(task) {
    var assignee = normalizeAssignee(task);
    if (assignee.mode === 'person') return true;
    if (assignee.email) return true;
    if (!assignee.value) return false;
    if (/team/i.test(assignee.value)) return false;
    return true;
  }

  function buildTask(task, sourceType, contextLabel) {
    var assignee = normalizeAssignee(task);
    return {
      id: String(task.id),
      title: normalizeLabel(task),
      description: String(task.description || task.notes || ''),
      contextLabel: normalizeContext(task, contextLabel),
      status: String(task.status || 'Pending'),
      priority: String(task.priority || 'Medium'),
      sourceType: sourceType,
      assigneeKey: assignee.email || slugify(assignee.name || assignee.value),
      assigneeLabel: assignee.name || assignee.email || assignee.value || 'Unassigned',
      assigneeEmail: assignee.email,
      updatedAt: String(task.updatedAt || task.startDateTime || task.createdAt || '')
    };
  }

  function collectTasks(workspace, community) {
    var rows = [];

    function add(task, sourceType, contextLabel) {
      if (!task || task.id === undefined || task.id === null) return;
      if (!looksLikePerson(task)) return;
      rows.push(buildTask(task, sourceType, contextLabel));
    }

    ((workspace && workspace.tasks) || []).forEach(function (task) {
      add(task, 'workspace', task.campaign || 'Assigned Tasks');
    });

    ((workspace && workspace.standaloneTasks) || []).forEach(function (task) {
      add(task, 'standalone', task.campaign || 'Standalone Tasks');
    });

    ((workspace && workspace.opsCampaigns) || []).forEach(function (campaign) {
      ((campaign && campaign.teamPlans) || []).forEach(function (plan) {
        ((plan && plan.tasks) || []).forEach(function (task) {
          add(task, 'campaign', (campaign && campaign.name) || 'Campaign');
        });
      });
    });

    var countries = community && community.data && community.data.countries ? community.data.countries : [];
    countries.forEach(function (country) {
      ((country && country.tasks) || []).forEach(function (task) {
        add(task, 'community', country.name || 'Community');
      });
    });

    rows.sort(function (a, b) {
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });

    return rows;
  }

  function collectAssignees(tasks) {
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

  function summarizeStatuses(tasks) {
    return tasks.reduce(
      function (acc, task) {
        var tone = statusTone(task.status);
        acc.total += 1;
        acc[tone] += 1;
        return acc;
      },
      { total: 0, pending: 0, progress: 0, blocked: 0, done: 0 }
    );
  }

  function dedupePresenceUsers(channel) {
    if (!channel || typeof channel.presenceState !== 'function') return [];
    var stateMap = channel.presenceState() || {};
    var deduped = new Map();

    Object.keys(stateMap).forEach(function (key) {
      (stateMap[key] || []).forEach(function (entry) {
        var email = String((entry && entry.email) || '').toLowerCase();
        if (!email) return;
        deduped.set(email, {
          email: email,
          name: String(entry.name || entry.email || ''),
          page: String(entry.page || '')
        });
      });
    });

    return Array.from(deduped.values()).sort(function (a, b) {
      return a.email.localeCompare(b.email);
    });
  }

  function fetchJson(url) {
    return window
      .fetch(url, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + anonKey()
        }
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Request failed: ' + response.status);
        }
        return response.json();
      });
  }

  function loadSupabaseClient() {
    if (supabaseClientPromise) return supabaseClientPromise;
    supabaseClientPromise = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
      .then(function (mod) {
        return mod.createClient('https://' + PROJECT_ID + '.supabase.co', anonKey(), {
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

  function render() {
    var tasks = collectTasks(state.workspace || {}, state.community || {});
    var assignees = collectAssignees(tasks);
    var selectedAssignee = state.selectedAssignee;

    if (!selectedAssignee || !assignees.some(function (item) { return item.key === selectedAssignee; })) {
      selectedAssignee = assignees.length ? assignees[0].key : '';
      state.selectedAssignee = selectedAssignee;
    }

    var selectedGroup = assignees.find(function (item) { return item.key === selectedAssignee; }) || null;
    var selectedTasks = selectedGroup ? selectedGroup.tasks : [];
    var selectedSummary = summarizeStatuses(selectedTasks);
    var viewer = getCurrentUser();
    var viewerLabel = viewer ? viewer.name || viewer.email : 'Guest';
    var viewerEmail = viewer ? viewer.email : 'No auth detected';
    var openTasks = tasks.filter(function (task) { return statusTone(task.status) !== 'done'; }).length;
    var totalSummary = summarizeStatuses(tasks);
    var selectedTask = selectedTasks.find(function (task) { return task.id === state.selectedTaskId; }) || null;

    root.innerHTML =
      '<div class="liveops-shell">' +
      '  <section class="liveops-hero">' +
      '    <div class="liveops-hero-grid">' +
      '      <div>' +
      '        <div class="liveops-kicker"><span class="liveops-kicker-dot"></span>Operations Surface</div>' +
      '        <h1 class="liveops-title">Live Ops</h1>' +
      '        <p class="liveops-copy">Monitor active users and person-owned work from campaigns, community, and assigned queues in one clean workspace. Click a person to focus their load, then open any task for context.</p>' +
      '        <div class="liveops-route">Routes: <strong>/tasks</strong> <strong>/tasks-daily-routines</strong> <strong>/live-ops</strong></div>' +
      '      </div>' +
      '      <div class="liveops-hero-actions">' +
      '        <div class="liveops-hero-card">' +
      '          <div class="liveops-hero-label">Signed-in Viewer</div>' +
      '          <div class="liveops-hero-value">' + escapeHtml(viewerLabel) + '</div>' +
      '          <div class="liveops-hero-note">' + escapeHtml(viewerEmail) + '</div>' +
      '        </div>' +
      '        <div class="liveops-actions">' +
      '          <a class="liveops-link" href="/">Back to dashboard</a>' +
      '          <button type="button" class="liveops-button" data-action="refresh">Refresh data</button>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '    <div class="liveops-hero-footer">' +
      '      <article class="liveops-hero-stat">' +
      '        <div class="liveops-hero-stat-label">Active now</div>' +
      '        <div class="liveops-hero-stat-value">' + state.liveUsers.length + '</div>' +
      '        <div class="liveops-hero-stat-copy">Users currently publishing presence from the tool.</div>' +
      '      </article>' +
      '      <article class="liveops-hero-stat">' +
      '        <div class="liveops-hero-stat-label">Open assigned</div>' +
      '        <div class="liveops-hero-stat-value">' + openTasks + '</div>' +
      '        <div class="liveops-hero-stat-copy">Assigned tasks that are not marked done yet.</div>' +
      '      </article>' +
      '      <article class="liveops-hero-stat">' +
      '        <div class="liveops-hero-stat-label">Owners</div>' +
      '        <div class="liveops-hero-stat-value">' + assignees.length + '</div>' +
      '        <div class="liveops-hero-stat-copy">People with live assigned work you can inspect.</div>' +
      '      </article>' +
      '    </div>' +
      '  </section>' +
      (state.error ? '<div class="liveops-banner is-error">' + escapeHtml(state.error) + '</div>' : '') +
      (state.loading ? '<div class="liveops-banner">Refreshing live data…</div>' : '') +
      '  <section class="liveops-metrics">' +
      '    <article class="liveops-metric-card"><div class="liveops-metric-label">Assigned tasks</div><div class="liveops-metric">' + tasks.length + '</div><div class="liveops-metric-note">All tasks assigned to actual people across workspace data.</div></article>' +
      '    <article class="liveops-metric-card"><div class="liveops-metric-label">In progress</div><div class="liveops-metric">' + totalSummary.progress + '</div><div class="liveops-metric-note">Tasks actively moving, under review, or being worked.</div></article>' +
      '    <article class="liveops-metric-card"><div class="liveops-metric-label">Blocked</div><div class="liveops-metric">' + totalSummary.blocked + '</div><div class="liveops-metric-note">Items that need attention before they can move again.</div></article>' +
      '    <article class="liveops-metric-card"><div class="liveops-metric-label">Current focus</div><div class="liveops-metric is-small">' + escapeHtml(selectedGroup ? selectedGroup.label : 'No assignee selected') + '</div><div class="liveops-metric-note">' + escapeHtml(selectedGroup ? String(selectedGroup.count) + ' tasks selected' : 'Choose a person from the left rail.') + '</div></article>' +
      '  </section>' +
      '  <section class="liveops-panel liveops-users">' +
      '    <div class="liveops-users-head"><span class="liveops-inline-label">Live users</span><span class="liveops-inline-value">' + state.liveUsers.length + ' active now</span></div>' +
      (state.liveUsers.length
        ? '<div class="liveops-user-strip">' + state.liveUsers.map(function (user) {
            return '<span class="liveops-user-chip"><span class="liveops-user-dot"></span>' + escapeHtml(user.name || user.email) + '</span>';
          }).join('') + '</div>'
        : '<div class="liveops-empty">No active users detected yet.</div>') +
      '  </section>' +
      '  <section class="liveops-workspace">' +
      '    <aside class="liveops-panel">' +
      '      <div class="liveops-panel-head"><div><div class="liveops-inline-label">People</div><div class="liveops-panel-title">Assignment rail</div><div class="liveops-panel-copy">Click any person to inspect the work currently assigned to them.</div></div><span class="liveops-count">' + assignees.length + '</span></div>' +
      (assignees.length
        ? '<div class="liveops-roster">' + assignees.map(function (person) {
            return '<button type="button" class="liveops-roster-item' + (person.key === selectedAssignee ? ' is-active' : '') + '" data-person="' + escapeHtml(person.key) + '">' +
              '<div class="liveops-roster-top">' +
              '<div><div class="liveops-roster-name">' + escapeHtml(person.label) + '</div>' +
              (person.email ? '<div class="liveops-roster-email">' + escapeHtml(person.email) + '</div>' : '') + '</div>' +
              '<span class="liveops-roster-count">' + person.count + '</span>' +
              '</div>' +
            '</button>';
          }).join('') + '</div>'
        : '<div class="liveops-empty">No assigned people were found.</div>') +
      '    </aside>' +
      '    <div class="liveops-stage">' +
      '      <section class="liveops-stage-card">' +
      (selectedGroup
        ? '<div class="liveops-focus">' +
          '<div>' +
          '<div class="liveops-inline-label">Selected assignee</div>' +
          '<h2 class="liveops-focus-name">' + escapeHtml(selectedGroup.label) + '</h2>' +
          (selectedGroup.email ? '<div class="liveops-focus-email">' + escapeHtml(selectedGroup.email) + '</div>' : '') +
          '<div class="liveops-focus-copy">This view is scoped to one person so you can scan current load, blocked work, and the specific items they own without switching pages.</div>' +
          '</div>' +
          '<div class="liveops-status-grid">' +
          '<div class="liveops-status-box"><div class="liveops-status-label">Total</div><div class="liveops-status-value">' + selectedSummary.total + '</div><div class="liveops-status-copy">All assigned items in the current focus.</div></div>' +
          '<div class="liveops-status-box is-progress"><div class="liveops-status-label">In progress</div><div class="liveops-status-value">' + selectedSummary.progress + '</div><div class="liveops-status-copy">Active items currently moving.</div></div>' +
          '<div class="liveops-status-box is-blocked"><div class="liveops-status-label">Blocked</div><div class="liveops-status-value">' + selectedSummary.blocked + '</div><div class="liveops-status-copy">Needs input or intervention.</div></div>' +
          '<div class="liveops-status-box is-done"><div class="liveops-status-label">Done</div><div class="liveops-status-value">' + selectedSummary.done + '</div><div class="liveops-status-copy">Completed items still visible in data.</div></div>' +
          '</div>' +
          '</div>'
        : '<div class="liveops-empty">Choose a person from the assignment rail to load their work.</div>') +
      '      </section>' +
      '      <section class="liveops-stage-card">' +
      '        <div class="liveops-tasklist-head"><div><div class="liveops-inline-label">Tasks</div><div class="liveops-panel-title">Assigned work</div><div class="liveops-panel-copy">Every task row is clickable. Open one to see its description and routing context.</div></div><span class="liveops-count">' + escapeHtml(selectedGroup ? String(selectedGroup.count) : '0') + '</span></div>' +
      (selectedTasks.length
        ? '<div class="liveops-tasklist">' + selectedTasks.map(function (task) {
            var tone = statusTone(task.status);
            var open = selectedTask ? selectedTask.id === task.id : false;
            return '<button type="button" class="liveops-task' + (open ? ' is-open' : '') + '" data-task="' + escapeHtml(task.id) + '">' +
              '<div class="liveops-task-head">' +
              '<div>' +
              '<div class="liveops-task-title">' + escapeHtml(task.title) + '</div>' +
              '<div class="liveops-task-context">' + escapeHtml(task.contextLabel) + '</div>' +
              '</div>' +
              '<div class="liveops-task-tags">' +
              '<span class="liveops-task-tag is-' + tone + '">' + escapeHtml(task.status) + '</span>' +
              '<span class="liveops-task-tag">' + escapeHtml(sourceLabel(task.sourceType)) + '</span>' +
              '</div>' +
              '</div>' +
              '<div class="liveops-task-meta">' +
              '<span class="liveops-task-meta-item">' + escapeHtml(task.priority) + ' priority</span>' +
              (task.updatedAt ? '<span class="liveops-task-meta-item">' + escapeHtml(task.updatedAt.slice(0, 10)) + '</span>' : '') +
              '</div>' +
              (open ? '<div class="liveops-task-body">' + escapeHtml(task.description || 'No description available for this task yet.') + '</div>' : '') +
            '</button>';
          }).join('') + '</div>'
        : '<div class="liveops-empty">Select a person to inspect their assigned tasks.</div>') +
      '      </section>' +
      '    </div>' +
      '  </section>';
  }

  function refreshSnapshots() {
    if (refreshInFlight) return Promise.resolve();
    refreshInFlight = true;
    state.loading = true;
    state.error = '';
    render();

    return Promise.all([
      fetchJson(API_BASE + '/data').catch(function () { return null; }),
      fetchJson(API_BASE + '/community-team-data').catch(function () { return null; })
    ])
      .then(function (results) {
        state.workspace = results[0] || {};
        state.community = results[1] || {};
        state.loading = false;
        render();
      })
      .catch(function () {
        state.loading = false;
        state.error = 'Could not load live data right now.';
        render();
      })
      .finally(function () {
        refreshInFlight = false;
      });
  }

  function startPresenceTracking() {
    var user = getCurrentUser();
    var key = user && user.email ? user.email.toLowerCase() : 'viewer-' + Math.random().toString(36).slice(2);
    if (presenceChannel && presenceIdentity === key) return;

    loadSupabaseClient().then(function (client) {
      if (!client) return;

      if (presenceChannel) {
        try {
          client.removeChannel(presenceChannel);
        } catch (err) {}
        presenceChannel = null;
      }

      presenceIdentity = key;
      var channel = client.channel('platform-presence', {
        config: {
          presence: {
            key: key
          }
        }
      });

      function syncPresence() {
        state.liveUsers = dedupePresenceUsers(channel);
        render();
      }

      function track() {
        channel.track({
          user_id: key,
          email: key,
          name: (user && (user.name || user.email)) || 'Viewer',
          page: window.location.pathname,
          online_at: new Date().toISOString()
        }).catch(function () {});
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
    });
  }

  root.addEventListener('click', function (event) {
    var action = event.target && event.target.closest ? event.target.closest('[data-action],[data-person],[data-task]') : null;
    if (!action) return;

    if (action.getAttribute('data-action') === 'refresh') {
      refreshSnapshots();
      return;
    }

    var person = action.getAttribute('data-person');
    if (person) {
      state.selectedAssignee = person;
      state.selectedTaskId = '';
      render();
      return;
    }

    var task = action.getAttribute('data-task');
    if (task) {
      state.selectedTaskId = state.selectedTaskId === task ? '' : task;
      render();
    }
  });

  window.addEventListener('focus', refreshSnapshots);
  refreshSnapshots();
  startPresenceTracking();
  window.setInterval(refreshSnapshots, SNAPSHOT_POLL_MS);
})();
