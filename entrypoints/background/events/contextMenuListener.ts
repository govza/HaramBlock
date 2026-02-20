import { t } from '@/utils/i18n';
import { logger } from '@/utils/logger';

import type { ForcedVisibility } from '@/utils/types';

type MenuAction = 'block' | 'show' | 'auto';

const MENU_PREFIX = 'haramblock';

const ACTION_TO_VISIBILITY: Record<MenuAction, ForcedVisibility> = {
  block: 'blocked',
  show: 'visible',
  auto: 'auto',
};

export class ContextMenuListener {
  private onToggleCallback: ((src: string, forcedVisibility: ForcedVisibility) => void) | null = null;

  initialize(onToggle: (src: string, forcedVisibility: ForcedVisibility) => void): void {
    this.onToggleCallback = onToggle;
    this.createMenuItems();
    this.listenForClicks();
  }

  private createMenuItems(): void {
    void browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: `${MENU_PREFIX}-auto`,
      title: `✦ ${t('ContextMenu.autoImage')}`,
      contexts: ['image'],
    });
    browser.contextMenus.create({
      id: `${MENU_PREFIX}-block`,
      title: `✕ ${t('ContextMenu.blockImage')}`,
      contexts: ['image'],
    });
    browser.contextMenus.create({
      id: `${MENU_PREFIX}-show`,
      title: `✓ ${t('ContextMenu.showImage')}`,
      contexts: ['image'],
    });
  }

  private listenForClicks(): void {
    browser.contextMenus.onClicked.addListener((info, tab) => {
      if (!info.srcUrl || !tab?.id) return;

      const action = this.parseAction(info.menuItemId);
      if (!action) return;

      if (!this.onToggleCallback) {
        logger.withTag('contextMenu').error('Toggle callback not set');
        return;
      }

      this.onToggleCallback(info.srcUrl, ACTION_TO_VISIBILITY[action]);
    });
  }

  private parseAction(menuItemId: string | number): MenuAction | null {
    const str = String(menuItemId);
    if (!str.startsWith(`${MENU_PREFIX}-`)) return null;
    const action = str.slice(MENU_PREFIX.length + 1);
    if (action === 'block' || action === 'show' || action === 'auto') return action;
    return null;
  }
}
