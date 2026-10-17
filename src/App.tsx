/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Laptop, Moon, Smartphone, Sun } from 'lucide-react';
import { ControllerDashboard } from './components/ControllerDashboard';
import { DeviceAgentView } from './components/DeviceAgentView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { detectDefaultAppMode } from './lib/hardwareTelemetry';
import { AppMode } from './types/opticlink';

const STORAGE_THEME_KEY = 'opticlink_theme_v1';

export default function App() {
  // Auto-Detect Mode: Desktop -> Web Controller Dashboard, Mobile/APK -> Phone Agent
  const [appMode, setAppMode] = useState<AppMode>(() => detectDefaultAppMode());

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
      <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-slate-50 dark:bg-[#0B0F19] text-slate-900 dark:text-slate-100 flex flex-col">
        {/* Responsive 3-Zone Top Bar (320px Small Screens -> 1920px+ Large Screens) */}
        <header className="w-full max-w-full border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-3 sm:px-6 lg:px-8 py-2.5 sm:py-3">
          <div className="w-full max-w-[1760px] mx-auto flex items-center justify-between gap-2 sm:gap-6">
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
              }}
              className="text-sm sm:text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 font-display"
            >
              OpticLink
            </a>

            <nav className="flex items-center gap-2.5 sm:gap-6 text-xs sm:text-sm font-medium text-slate-600 dark:text-slate-300">
              <button
                type="button"
                onClick={() => setAppMode('CONTROLLER')}
                className={`flex items-center gap-1.5 py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  appMode === 'CONTROLLER'
                    ? 'text-blue-600 dark:text-blue-400 font-semibold underline underline-offset-4'
                    : 'hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Laptop className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden md:inline">Web Controller Dashboard</span>
                <span className="md:hidden">Controller</span>
              </button>

              <button
                type="button"
                onClick={() => setAppMode('AGENT')}
                className={`flex items-center gap-1.5 py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  appMode === 'AGENT'
                    ? 'text-emerald-600 dark:text-emerald-400 font-semibold underline underline-offset-4'
                    : 'hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5 shrink-0" />
                <span>Phone Agent</span>
              </button>
            </nav>

            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setDarkMode((d) => !d)}
                className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                title="Toggle Theme"
              >
                {darkMode ? (
                  <Sun className="w-4 h-4 text-amber-400" />
                ) : (
                  <Moon className="w-4 h-4" />
                )}
              </button>
              <PWAInstallButton />
            </div>
          </div>
        </header>

        {/* Main Content Viewport (Scales cleanly from 320px Mobile up to 1760px Widescreen Desktop) */}
        <main className="flex-1 w-full max-w-[1760px] mx-auto px-2.5 sm:px-6 lg:px-8 py-3 sm:py-6 overflow-x-hidden">
          {appMode === 'CONTROLLER' ? <ControllerDashboard /> : <DeviceAgentView />}
        </main>

        <OfflineIndicator />
      </div>
    </div>
  );
}
