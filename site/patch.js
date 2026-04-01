/* trygc-patch: notification sound alerts */
(function () {
  'use strict';

  var NOTIF_KEY = 'trygc-task-notifications';
  var AUTH_KEY = 'supabase.auth.token';
  var seenIds = new Set();
  var initialized = false;

  function getUserEmail() {
    try {
      var raw = localStorage.getItem(AUTH_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      return (
        (p && p.user && p.user.email) ||
        (p && p.currentSession && p.currentSession.user && p.currentSession.user.email) ||
        (p && p.session && p.session.user && p.session.user.email) ||
        null
      );
    } catch (e) { return null; }
  }

  function playSound() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      function tone(freq, t0, dur, vol) {
        var osc = ctx.createOscillator();
        var g = ctx.createGain();
        osc.connect(g);
        g.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        g.gain.setValueAtTime(vol, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
        osc.start(t0);
        osc.stop(t0 + dur + 0.01);
      }
      var now = ctx.currentTime;
      tone(880, now, 0.12, 0.35);
      tone(1100, now + 0.13, 0.18, 0.28);
      tone(1320, now + 0.30, 0.22, 0.20);
    } catch (e) {}
  }

  function showBrowserNotif(title, body) {
    if (!('Notification' in window)) return;
    function doShow() {
      try {
        new Notification(title, {
          body: body,
          icon: '/trygc-favicon.png',
          badge: '/trygc-favicon.png',
          tag: 'trygc-assignment'
        });
      } catch (e) {}
    }
    if (Notification.permission === 'granted') {
      doShow();
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(function (p) {
        if (p === 'granted') doShow();
      });
    }
  }

  function checkForNew() {
    var email = getUserEmail();
    if (!email) return;
    var emailLc = email.toLowerCase();

    try {
      var raw = localStorage.getItem(NOTIF_KEY);
      if (!raw) return;
      var list = JSON.parse(raw);
      if (!Array.isArray(list)) return;

      list.forEach(function (n) {
        if (!n || !n.id) return;
        var id = String(n.id);
        if (seenIds.has(id)) return;
        seenIds.add(id);

        // Skip already-read notifications or ones not for this user
        if (n.read) return;
        var assignedTo = (n.assignedTo || n.assignedToEmail || '').toLowerCase();
        if (!assignedTo || assignedTo !== emailLc) return;

        // New unread assignment for current user
        playSound();
        var taskTitle = n.taskName || 'New Task';
        var taskDesc = n.taskDescription || n.description || '';
        var msg = taskDesc ? taskTitle + ' — ' + taskDesc.substring(0, 80) : taskTitle;
        showBrowserNotif('New Assignment', msg);
      });
    } catch (e) {}
  }

  function seedSeen() {
    // Populate seenIds with already-existing notifications so we don't alert on page load
    try {
      var raw = localStorage.getItem(NOTIF_KEY);
      if (!raw) return;
      var list = JSON.parse(raw);
      if (Array.isArray(list)) {
        list.forEach(function (n) { if (n && n.id) seenIds.add(String(n.id)); });
      }
    } catch (e) {}
  }

  function requestPermEarly() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      var fired = false;
      var handler = function () {
        if (fired) return;
        fired = true;
        document.removeEventListener('click', handler, true);
        document.removeEventListener('keydown', handler, true);
        Notification.requestPermission();
      };
      document.addEventListener('click', handler, true);
      document.addEventListener('keydown', handler, true);
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    requestPermEarly();
    seedSeen();

    // Intercept same-window localStorage writes
    var _set = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, val) {
      _set(key, val);
      if (key === NOTIF_KEY) setTimeout(checkForNew, 50);
    };

    // Cross-tab storage events
    window.addEventListener('storage', function (e) {
      if (e.key === NOTIF_KEY) setTimeout(checkForNew, 50);
    });

    // Polling fallback (every 4 seconds)
    setInterval(checkForNew, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
