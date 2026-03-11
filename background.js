const openWindows = new Set();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

if (chrome.sidePanel.onOpened) {
  chrome.sidePanel.onOpened.addListener(({ windowId }) => {
    openWindows.add(windowId);
  });
}

if (chrome.sidePanel.onClosed) {
  chrome.sidePanel.onClosed.addListener(({ windowId }) => {
    openWindows.delete(windowId);
  });
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-side-panel') return;

  const currentWindow = await chrome.windows.getCurrent();
  const windowId = currentWindow.id;

  if (typeof windowId !== 'number') return;

  // `close()` landed after `open()`, so older Chrome versions fall back to open-only.
  if (openWindows.has(windowId) && chrome.sidePanel.close) {
    await chrome.sidePanel.close({ windowId });
    return;
  }

  await chrome.sidePanel.open({ windowId });
  openWindows.add(windowId);
});
