'use strict';

// Theme toggle for dark/light mode. Each HTML page already runs a tiny
// inline snippet in <head> that sets data-theme early (no FOUC). This
// file exposes window.toggleTheme() for the in-app button.

(function () {
    function currentEffective() {
        const attr = document.documentElement.getAttribute('data-theme');
        if (attr === 'dark' || attr === 'light') return attr;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark' : 'light';
    }

    function apply(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem('theme', theme); } catch (_) {}
        const btn = document.getElementById('btn-theme');
        if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
    }

    window.toggleTheme = function () {
        apply(currentEffective() === 'dark' ? 'light' : 'dark');
    };

    // When DOM is ready, sync the button icon to the current effective theme.
    document.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('btn-theme');
        if (btn) btn.textContent = currentEffective() === 'dark' ? '☀' : '☾';
    });
})();
