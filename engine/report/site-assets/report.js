(() => {
  const body = document.body;
  document.querySelector('[data-sidebar-open]')?.addEventListener('click', () => body.classList.add('sidebar-open'));
  document.querySelectorAll('[data-sidebar-close]').forEach((el) => el.addEventListener('click', () => body.classList.remove('sidebar-open')));
  document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
  document.querySelectorAll('.report-nav a').forEach((a) => a.addEventListener('click', () => body.classList.remove('sidebar-open')));
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') body.classList.remove('sidebar-open');
  });
  const sectionLinks = [...document.querySelectorAll('[data-section-link]')];
  const sections = sectionLinks.map((a) => document.getElementById(a.dataset.sectionLink)).filter(Boolean);
  if (sections.length) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      sectionLinks.forEach((a) => a.classList.toggle('active', a.dataset.sectionLink === visible.target.id));
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    sections.forEach((section) => observer.observe(section));
  }
  const updateProgress = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    const value = max > 0 ? Math.min(100, Math.max(0, scrollY / max * 100)) : 0;
    document.getElementById('reading-progress')?.style.setProperty('--progress', value + '%');
  };
  addEventListener('scroll', updateProgress, { passive: true });
  updateProgress();
  const nav = document.querySelector('.report-nav');
  if (nav) {
    try {
      const key = 'project-analysis-nav:' + location.pathname;
      const saved = sessionStorage.getItem(key);
      if (saved) nav.scrollTop = Number(saved);
      nav.addEventListener('scroll', () => sessionStorage.setItem(key, String(nav.scrollTop)), { passive: true });
    } catch {
      // file:// viewers may disable storage; navigation still works without it.
    }
  }
  const diagrams = [...document.querySelectorAll('pre.mermaid')];
  if (diagrams.length && window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, sans-serif',
        fontSize: '14px',
        lineColor: '#718096',
        primaryTextColor: '#172b4d'
      },
      flowchart: { htmlLabels: false, curve: 'basis', useMaxWidth: true }
    });
    window.mermaid.run({ nodes: diagrams }).catch((error) => {
      console.error('Mermaid rendering failed', error);
      diagrams.forEach((diagram) => diagram.closest('.diagram-frame')?.classList.add('diagram-error'));
    });
  } else if (diagrams.length) {
    diagrams.forEach((diagram) => diagram.closest('.diagram-frame')?.classList.add('diagram-error'));
  }
})();
