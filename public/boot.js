// Runs before the app bundle. In WebView2, Escape stops a loading page and would leave the
// window blank; src-tauri/src/lib.rs reloads the page if a load is aborted anyway.
addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('#app')?.childElementCount) event.preventDefault(); }, true);
