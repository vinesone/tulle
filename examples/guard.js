/**
 * Classic (non-module) script on purpose: over file:// the module scripts these
 * pages rely on are blocked by CORS before they run, so only a classic script
 * can still execute and report why the page is blank.
 */
if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.querySelector('.status')
    if (!el) return
    el.innerHTML =
      'This page must be served over http://, not opened as a file.<br>' +
      'ES module imports are blocked by CORS on file:// origins.<br><br>' +
      'Run <b>npm run dev</b> from the project root, then open<br>' +
      '<b>http://localhost:8080/examples/</b>'
    el.classList.add('error')
  })
}
