/**
 * App shell (Phase 2a/2b) — the old app's one-screen composition over the
 * phone core: a machine-grouped session Sidebar (with the bottom-pinned DM
 * section) beside (wide ≥700px) or over (narrow: drawer + scrim) the
 * MainPanel, which switches on the ui store's panelMode. The stacked-screen
 * topbar navigation is gone.
 *
 * Settings / Pairing stay reachable as ScreenOverlay full-screens. UI-scale +
 * keyboard-inset controllers write :root custom properties consumed by the
 * tokens; safe-area handling lives ONCE in App.module.css (ScreenOverlay,
 * being fixed, consumes its own).
 */
import { useEffect, useState } from 'react';
import { usePairing, usePhoneCore, useUi } from './coreContext';
import { MainPanel } from './MainPanel';
import { PairingScreen } from './screens/PairingScreen';
import { ScreenOverlay } from './ScreenOverlay';
import { SettingsScreen } from './screens/SettingsScreen';
import { Sidebar } from './Sidebar';
import { UndoToast } from './UndoToast';
import { useKeyboardInset } from './useKeyboardInset';
import { useMediaQuery } from './useMediaQuery';
import { useUiScale } from './useUiScale';
import styles from './App.module.css';

export function App() {
  useUiScale();
  useKeyboardInset();

  const core = usePhoneCore();
  const isWide = useMediaQuery('(min-width: 700px)');
  const pairingPhase = usePairing((s) => s.phase);
  const pairingStaged = usePairing((s) => s.staged);

  const panelMode = useUi((s) => s.panelMode);
  const selectedSession = useUi((s) => s.selectedSession);
  const activeDmPeer = useUi((s) => s.activeDmPeer);
  const activeMarmotGroup = useUi((s) => s.activeMarmotGroup);
  const hasSelection =
    panelMode === 'session'
      ? selectedSession !== null
      : panelMode === 'dm'
        ? activeDmPeer !== null
        : activeMarmotGroup !== null;

  // Narrow: default open when nothing is selected (old-app behaviour — the
  // sidebar IS the home surface); tapping a card closes it.
  const [sidebarOpen, setSidebarOpen] = useState(() => !hasSelection);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // First run (no machines paired) starts on pairing, as before.
  const [pairingOpen, setPairingOpen] = useState(
    () => Object.keys(core.machines.getState().machines).length === 0,
  );

  // A deep link (codedeck://pair…) starts the flow from anywhere — surface it.
  useEffect(() => {
    if (pairingPhase !== 'idle' || pairingStaged) setPairingOpen(true);
  }, [pairingPhase, pairingStaged]);

  const closeDrawer = (): void => setSidebarOpen(false);

  const sidebar = (
    <Sidebar
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenPairing={() => setPairingOpen(true)}
      {...(!isWide ? { onSessionSelected: closeDrawer } : {})}
    />
  );

  return (
    <div className={styles.app}>
      {isWide ? (
        <div className={styles.sidebarWide}>{sidebar}</div>
      ) : (
        <>
          {sidebarOpen && <div className={styles.scrim} data-testid="scrim" onClick={closeDrawer} />}
          <div
            className={
              sidebarOpen ? `${styles.drawer} ${styles.drawerOpen}` : styles.drawer
            }
            data-testid="drawer"
            data-open={sidebarOpen}
          >
            {sidebar}
          </div>
        </>
      )}

      <MainPanel isWide={isWide} onOpenSidebar={() => setSidebarOpen(true)} />

      {settingsOpen && (
        <ScreenOverlay title="Settings" onClose={() => setSettingsOpen(false)}>
          <SettingsScreen />
        </ScreenOverlay>
      )}

      {pairingOpen && (
        <ScreenOverlay title="Pair a machine" onClose={() => setPairingOpen(false)}>
          <PairingScreen onDone={() => setPairingOpen(false)} />
        </ScreenOverlay>
      )}

      {/* Pending-delete undo (Phase 3) — fixed above the drawer/overlays. */}
      <UndoToast />
    </div>
  );
}
