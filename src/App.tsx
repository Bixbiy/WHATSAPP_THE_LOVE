/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { ControllerDashboard } from './components/ControllerDashboard';
import { DeviceAgentView } from './components/DeviceAgentView';
import { OfflineIndicator } from './components/PWAInstallButton';
import { detectDefaultAppRole } from './lib/hardwareTelemetry';
import { AppRole } from './types/opticlink';

const STORAGE_THEME_KEY = 'opticlink_theme_v1';

export default function App() {
  // Strict Role Separation:
  // - Android APK (window.Capacitor / window.AndroidBridge), mobile screen (<768px / mobile UA), or ?role=node -> 'NODE'
  // - Desktop browser -> 'CONTROLLER'
  const [role, setRole] = useState<AppRole>(() => detectDefaultAppRole());

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    const saved = localStorage.getItem(STORAGE_THEME_KEY);
    return saved ? saved === 'dark' : true;
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_THEME_KEY, darkMode ? 'dark' : 'light');
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  return (
    <div className={darkMode ? 'dark' : ''}>
      {role === 'NODE' ? (
        <DeviceAgentView onSwitchToController={() => setRole('CONTROLLER')} />
      ) : (
        <ControllerDashboard
          onSwitchToNode={() => setRole('NODE')}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((d) => !d)}
        />
      )}
      <OfflineIndicator />
    </div>
  );
}
