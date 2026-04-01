/* Vercel Speed Insights initialization */
(function() {
  'use strict';

  // Initialize Speed Insights queue
  function initQueue() {
    if (window.si) return;
    window.si = function() {
      window.siq = window.siq || [];
      window.siq.push(Array.prototype.slice.call(arguments));
    };
  }

  // Inject Speed Insights script
  function injectSpeedInsights() {
    initQueue();

    // Check if script already exists
    var scriptSrc = '/_vercel/speed-insights/script.js';
    if (document.head.querySelector('script[src*="' + scriptSrc + '"]')) {
      return;
    }

    var script = document.createElement('script');
    script.src = scriptSrc;
    script.defer = true;
    
    // Add SDK metadata
    script.dataset.sdkn = '@vercel/speed-insights';
    script.dataset.sdkv = '2.0.0';

    script.onerror = function() {
      console.log('[Vercel Speed Insights] Failed to load script from ' + scriptSrc + '. Please check if any content blockers are enabled and try again.');
    };

    document.head.appendChild(script);
  }

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSpeedInsights);
  } else {
    injectSpeedInsights();
  }
})();
