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

async function getTargetWindowId() {
  const currentWindow = await chrome.windows.getLastFocused({
    populate: false,
    windowTypes: ['normal'],
  });

  return typeof currentWindow?.id === 'number' ? currentWindow.id : null;
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-side-panel') return;

  try {
    const windowId = await getTargetWindowId();

    if (windowId === null) {
      console.warn('Notebook: no focused browser window found for side panel toggle.');
      return;
    }

    // `close()` landed after `open()`, so older Chrome versions fall back to open-only.
    if (openWindows.has(windowId) && chrome.sidePanel.close) {
      await chrome.sidePanel.close({ windowId });
      return;
    }

    await chrome.sidePanel.open({ windowId });
    openWindows.add(windowId);
  } catch (error) {
    console.error('Notebook: failed to toggle side panel.', error);
  }
});
