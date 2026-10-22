export function scriptSafeJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function injectScript(name: string, tools: unknown): string {
	return `<script>
(function() {
  try {
    var modelContext = document.modelContext || navigator.modelContext;
    if (modelContext && typeof modelContext.registerTool === 'function') {
      function prototypeData() {
        var data = document.getElementById('prototype-data');
        return data ? JSON.parse(data.textContent) : { name: ${scriptSafeJson(name)}, variants: [], labels: {} };
      }
      function listVariants() {
        var data = prototypeData();
        return data.variants.map(function(key) { return { key: key, label: data.labels[key] || key }; });
      }
      var execute = {
        get_prototype_state: async function() {
          var active = document.querySelector('section[data-variant].is-active');
          var variant = active ? active.getAttribute('data-variant') : new URL(window.location.href).searchParams.get('variant');
          var data = prototypeData();
          var notes = document.querySelector('#proto-notes, #proto-decision-notes');
          var decision = await fetch('/prototype-state', { cache: 'no-store' }).then(function(r) { return r.json(); });
          return JSON.stringify({ chain: ${scriptSafeJson(name)}, round: data.name, variant: variant, label: data.labels[variant] || variant,
            notes: notes ? notes.value : '', status: decision.status });
        },
        list_prototype_variants: function() { return JSON.stringify(listVariants()); }
      };
      ${scriptSafeJson(tools)}.forEach(function(tool) {
        try {
          tool.execute = execute[tool.name];
          Promise.resolve(modelContext.registerTool(tool)).catch(function() {});
        } catch (e) {}
      });
    }
  } catch (e) {}

  var _FAVICON = { waiting: '⏳', processing: '🔄', done: '✅' };
  function _setFavicon(state) {
    var emoji = _FAVICON[state] || _FAVICON.waiting;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="54" font-size="80" text-anchor="middle" dominant-baseline="central">' + emoji + '</text></svg>';
    var href = 'data:image/svg+xml,' + encodeURIComponent(svg);
    var link = document.querySelector("link[rel='icon']");
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = href;
  }

  var _reloadToken = null;
  var _reloadIntervalId = null;
  function pollReload() {
    fetch('/prototype-reload').then(function(r){ return r.json(); }).then(function(d){
      if (_reloadToken === null) { _reloadToken = d.token; return; }
      if (d.token !== _reloadToken) { window.location.reload(); }
    }).catch(function(){});
  }
  _reloadIntervalId = setInterval(pollReload, 2000);

  function _closeOrFallback(onBlocked) {
    try { window.open('', '_self'); } catch (e) {}
    window.close();
    setTimeout(function() {
      if (!document.hidden) onBlocked();
    }, 300);
  }

  document.addEventListener('DOMContentLoaded', function() {
    fetch('/prototype-reload').then(function(r){ return r.json(); }).then(function(d){
      return fetch('/prototype-changes').then(function(r){ return r.json(); }).then(function(c){
        _renderChanges(c, d.token);
      });
    }).catch(function(){});
  });

  function _renderChanges(manifest, currentToken) {
    if (!manifest || !manifest.rev || manifest.rev !== currentToken) return;
    var screens = Array.isArray(manifest.screens) ? manifest.screens.filter(function(s){ return s && s.id; }) : [];
    if (!screens.length && !manifest.summary) return;

    var seenKey = 'protoChangesSeen:' + ${scriptSafeJson(name)};
    if (sessionStorage.getItem(seenKey) === currentToken) return;

    screens.forEach(function(s) {
      document.querySelectorAll('[data-go="' + s.id + '"]').forEach(function(navEl) {
        navEl.classList.add('_proto_changed_dot');
        navEl.addEventListener('click', function clearDot() {
          navEl.classList.remove('_proto_changed_dot');
          navEl.removeEventListener('click', clearDot);
        });
      });
    });

    var style = document.createElement('style');
    style.textContent = [
      '._proto_changed_dot{position:relative;}',
      '._proto_changed_dot::after{content:"";position:absolute;top:6px;right:6px;width:7px;height:7px;',
        'border-radius:50%;background:#4c8dff;box-shadow:0 0 0 2px rgba(76,141,255,0.25);}',
      '#_proto_changes_pill{position:fixed;right:1.25rem;bottom:1.25rem;z-index:80;',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;',
        'display:flex;flex-direction:column-reverse;align-items:flex-end;}',
      '#_proto_changes_btn{cursor:pointer;background:#4c8dff;color:#fff;border:none;border-radius:999px;',
        'padding:0.5rem 1rem;font-size:0.8rem;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,0.35);}',
      '#_proto_changes_panel{display:none;margin-bottom:0.5rem;background:#14181f;border:1px solid #2a2f3a;',
        'border-radius:10px;padding:1rem 1.1rem;width:300px;max-height:min(320px,50vh);overflow:auto;',
        'box-shadow:0 8px 30px rgba(0,0,0,0.5);}',
      '#_proto_changes_panel.is-open{display:block;}',
      '#_proto_changes_panel h4{margin:0 0 0.6rem;color:#e8ecf2;font-size:0.85rem;}',
      '#_proto_changes_panel ul{list-style:none;margin:0;padding:0;}',
      '#_proto_changes_panel li{color:#a8b0c0;font-size:0.8rem;line-height:1.5;padding:0.3rem 0;',
        'border-top:1px solid #232838;cursor:pointer;}',
      '#_proto_changes_panel li:first-child{border-top:none;}',
      '#_proto_changes_panel li b{color:#e8ecf2;}',
      '#_proto_changes_dismiss{margin-top:0.6rem;background:none;border:none;color:#6b7488;',
        'font-size:0.72rem;cursor:pointer;padding:0;}'
    ].join('');
    document.head.appendChild(style);

    var count = screens.length;
    var wrap = document.createElement('div');
    wrap.id = '_proto_changes_pill';
    var listHtml = screens.map(function(s) {
      return '<li data-go="' + s.id + '"><b>' + s.id + '</b>' + (s.note ? ' — ' + s.note : '') + '</li>';
    }).join('');
    wrap.innerHTML = [
      '<div id="_proto_changes_panel">',
        '<h4>' + (manifest.summary || 'What changed this revision') + '</h4>',
        '<ul>' + listHtml + '</ul>',
        '<button id="_proto_changes_dismiss" type="button">Dismiss</button>',
      '</div>',
      '<button id="_proto_changes_btn" type="button">' + count + ' screen' + (count === 1 ? '' : 's') + ' changed this revision</button>'
    ].join('');
    document.body.appendChild(wrap);

    function _repositionAboveBar() {
      var bar = document.getElementById('protobar');
      var visible = false;
      if (bar) {
        var cs = getComputedStyle(bar);
        visible = cs.display !== 'none' && cs.visibility !== 'hidden' && bar.offsetHeight > 0;
      }
      wrap.style.bottom = (visible ? bar.offsetHeight + 16 : 20) + 'px';
    }
    _repositionAboveBar();
    window.addEventListener('resize', _repositionAboveBar);

    document.getElementById('_proto_changes_btn').addEventListener('click', function() {
      document.getElementById('_proto_changes_panel').classList.toggle('is-open');
    });
    document.getElementById('_proto_changes_dismiss').addEventListener('click', function() {
      sessionStorage.setItem(seenKey, currentToken);
      wrap.remove();
      document.querySelectorAll('._proto_changed_dot').forEach(function(el){ el.classList.remove('_proto_changed_dot'); });
    });
    wrap.querySelectorAll('#_proto_changes_panel li[data-go]').forEach(function(li) {
      li.addEventListener('click', function() {
        var navEl = document.querySelector('[data-go="' + li.dataset.go + '"]');
        if (navEl && navEl !== li) navEl.click();
        navEl && navEl.classList.remove('_proto_changed_dot');
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function() {
    _setFavicon('waiting');
    document.querySelectorAll('form[action="/prototype-decision"]').forEach(function(form) {
      form.addEventListener('submit', function(e) {
        e.preventDefault();
        var fd = new FormData(form);
        var body = {};
        fd.forEach(function(v, k) { body[k] = v; });
        body.name = body.name || ${scriptSafeJson(name)};
        fetch('/prototype-decision', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(body)
        }).then(function(r){ return r.json(); }).then(function(d){
          if (d.ok) { _showDecisionOverlay(_overlayState(body), !!(body.notes && body.notes.trim())); }
        });
      });
    });
  });

  function _overlayState(body) {
    if (body && body.decision) {
      return String(body.decision).toUpperCase() === 'REWORK' ? 'rework' : 'approved';
    }
    return (body && body.action) || 'confirm';
  }

  function _showDecisionOverlay(state, hasNotes, variant) {
    var isRework = state === 'reject' || state === 'rework';
    var isApproved = state === 'approved';
    var isNextInSeries = state === 'confirm' && !hasNotes && window.__protoSeries === true;
    var isConfirmNoNotes = state === 'confirm' && !hasNotes && !isNextInSeries;
    _setFavicon(isRework || isNextInSeries || (!isApproved && hasNotes) ? 'processing' : 'done');
    var isBuilding = state === 'confirm' && (hasNotes || isNextInSeries);
    var pillColor = isRework || isBuilding ? '#e8a838' : '#2ebb6e';
    var pillLabel = isRework ? 'REWORKING' : (isBuilding ? 'BUILDING' : 'APPROVED');
    var subtitle = isNextInSeries
      ? 'Selection recorded. Keep this tab open: it reloads in place when the next prototype is ready.'
      : isBuilding
      ? 'Notes sent. Keep this tab open: it reloads in place when the next round is ready.'
      : isRework
      ? 'Reworking your prototype — this page reloads automatically when the new version is ready.'
      : (!isApproved && hasNotes
          ? 'Notes sent to AI Chat — this page reloads when the rework is ready.'
          : (isConfirmNoNotes
              ? 'Selection recorded — this tab will close automatically.'
              : 'Decision recorded — this tab will stay open for review or another iteration.'));
    var overlay = document.createElement('div');
    overlay.id = '_proto_overlay';
    overlay.innerHTML = [
      '<style>',
      '#_proto_overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;',
        'background:rgba(10,12,18,0.97);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
      '#_proto_card{background:#14181f;border:1px solid #2a2f3a;border-radius:12px;padding:2.5rem 3rem;',
        'max-width:480px;width:90%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.6);}',
      '#_proto_pill{display:inline-block;padding:0.25rem 0.75rem;border-radius:999px;font-size:0.7rem;',
        'font-weight:700;letter-spacing:0.08em;color:#fff;background:' + pillColor + ';margin-bottom:1.1rem;}',
      '#_proto_title{color:#e8ecf2;font-size:1.45rem;font-weight:600;margin:0 0 0.65rem;}',
      '#_proto_sub{color:#7a8499;font-size:0.9rem;line-height:1.5;margin:0 0 2rem;}',
      '#_proto_track{height:3px;border-radius:2px;background:#1e2330;overflow:hidden;position:relative;}',
      '#_proto_bar{position:absolute;top:0;left:-40%;width:40%;height:100%;',
        'background:#4c8dff;border-radius:2px;animation:_proto_slide 1.6s ease-in-out infinite;}',
      '@keyframes _proto_slide{0%{left:-40%;}100%{left:110%;}}',
      '</style>',
      '<div id="_proto_card">',
        '<div id="_proto_pill">' + pillLabel + '</div>',
        '<h2 id="_proto_title"></h2>',
        '<p id="_proto_sub">' + subtitle + '</p>',
        '<div id="_proto_track"><div id="_proto_bar"></div></div>',
      '</div>'
    ].join('');
    document.body.appendChild(overlay);
    document.getElementById('_proto_title').textContent = isNextInSeries
      ? 'Loading the next prototype…'
      : isBuilding
      ? 'Building the next round' + (variant ? ' from ' + variant : '') + '…'
      : 'Sent to AI Chat';
    if (!isConfirmNoNotes) return;
    if (_reloadIntervalId) { clearInterval(_reloadIntervalId); _reloadIntervalId = null; }
    setTimeout(function() {
      _closeOrFallback(function() {
        document.getElementById('_proto_pill').textContent = 'DONE';
        document.getElementById('_proto_title').textContent = 'You can close this tab';
        document.getElementById('_proto_sub').textContent = 'The prototype session has ended.';
        document.getElementById('_proto_track').style.display = 'none';
      });
    }, 2200);
  }

  window.prototypeDecide = function(action, variant, notes) {
    var hasNotes = !!(notes && notes.trim());
    _setFavicon(action === 'reject' || hasNotes ? 'processing' : 'done');
    fetch('/prototype-decision', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: ${scriptSafeJson(name)}, action: action || 'confirm', variant: variant || '', notes: notes || '' })
    }).then(function(r){ return r.json(); }).then(function(d){
      if (d.ok) { _showDecisionOverlay(action || 'confirm', hasNotes, variant); }
    });
  };

  window.prototypePlanDecision = function(decision, notes) {
    var normalized = String(decision || '').toUpperCase();
    fetch('/prototype-decision', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: ${scriptSafeJson(name)}, decision: normalized, notes: notes || '' })
    }).then(function(r){ return r.json(); }).then(function(d){
      if (d.ok) { _showDecisionOverlay(normalized === 'REWORK' ? 'rework' : 'approved', !!(notes && notes.trim())); }
    });
  };
})();
</script>
`;
}
