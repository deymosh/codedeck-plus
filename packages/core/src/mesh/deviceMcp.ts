/**
 * Device MCP server — wraps deviceActions as SDK MCP tools handed to *test
 * sessions* only. Ported from the MCP tail of
 * codedeck-bridge-vscode/src/deviceActions.ts (Phase 5d).
 *
 * The tool handlers are fully deterministic Node; Claude only chooses which
 * validated tool to call. Sessions NOT flagged `testSession` never see these
 * tools, so normal coding sessions get no device control.
 *
 * NOTE: `tool`/`createSdkMcpServer` are imported from the Agent SDK directly
 * (not via sdk/facade.ts) — they are stable public helpers, not the fragile
 * per-release surface the facade isolates; the old bridge imported them the
 * same way.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { DeviceActionResult, DeviceActions } from './deviceActions';

export interface DeviceMcpOptions {
  /** The device-action surface (one per BridgeCore — carries the port cache). */
  actions: DeviceActions;
  /** Where to write screenshot artifacts before delivery. */
  artifactDir: string;
  /** Called after a screenshot is captured; returns a short note to include in
   *  the tool result (e.g. "delivered to phone"). The bridge wires the
   *  downscale + publish-to-phone here (screenshotDelivery). */
  onScreenshot?: (artifactPath: string, serial: string) => Promise<string>;
}

function textResult(r: DeviceActionResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
} {
  const body = r.ok ? r.stdout || '(ok)' : `ERROR: ${r.stderr || 'failed'}`;
  return { content: [{ type: 'text' as const, text: body.slice(0, 60_000) }], isError: !r.ok };
}

export function createDeviceMcpServer(opts: DeviceMcpOptions): ReturnType<typeof createSdkMcpServer> {
  const a = opts.actions;
  return createSdkMcpServer({
    name: 'device',
    version: '0.1.0',
    tools: [
      tool(
        'connect',
        'Connect adb to the test device over the mesh (serial = mesh IP:port).',
        { serial: z.string() },
        async ({ serial }) => textResult(await a.connect(serial)),
      ),

      tool('list', 'List adb devices currently visible to the laptop.', {}, async () =>
        textResult(await a.list()),
      ),

      tool(
        'install',
        'Install (reinstall) an APK on the test device.',
        { serial: z.string(), apkPath: z.string() },
        async ({ serial, apkPath }) => textResult(await a.install(serial, apkPath)),
      ),

      tool(
        'launch',
        'Launch an app on the test device by package id (optional explicit activity).',
        { serial: z.string(), pkg: z.string(), activity: z.string().optional() },
        async ({ serial, pkg, activity }) => textResult(await a.launch(serial, pkg, activity)),
      ),

      tool(
        'logcat',
        'Fetch the last N lines of logcat (default 200, max 2000). Pass pkg (the app-under-test package id) to scope output to that app only — strongly preferred, so other apps’ logs/secrets never leave the device. Output is secret-redacted regardless.',
        { serial: z.string(), lines: z.number().optional(), pkg: z.string().optional() },
        async ({ serial, lines, pkg }) => textResult(await a.logcat(serial, lines ?? 200, pkg)),
      ),

      tool(
        'ui_dump',
        'Dump the current UI hierarchy as XML (small; use for assertions instead of screenshots).',
        { serial: z.string() },
        async ({ serial }) => textResult(await a.uiDump(serial)),
      ),

      tool(
        'screenshot',
        'Capture a screenshot of the test device and deliver it to the phone for the human to see.',
        { serial: z.string() },
        async ({ serial }) => {
          const r = await a.screenshotRaw(serial, opts.artifactDir);
          if (r.ok && r.artifactPath && opts.onScreenshot) {
            const note = await opts
              .onScreenshot(r.artifactPath, serial)
              .catch((e) => `delivery failed: ${String(e)}`);
            return { content: [{ type: 'text' as const, text: `Screenshot captured. ${note}` }] };
          }
          return textResult(r);
        },
      ),

      tool(
        'tap',
        'Tap the screen at pixel coordinates (x, y).',
        { serial: z.string(), x: z.number(), y: z.number() },
        async ({ serial, x, y }) => textResult(await a.tap(serial, x, y)),
      ),

      tool(
        'type_text',
        'Type text into the focused field.',
        { serial: z.string(), text: z.string() },
        async ({ serial, text }) => textResult(await a.typeText(serial, text)),
      ),

      tool(
        'key',
        'Send a key event (e.g. KEYCODE_BACK, KEYCODE_ENTER, KEYCODE_HOME).',
        { serial: z.string(), keycode: z.string() },
        async ({ serial, keycode }) => textResult(await a.key(serial, keycode)),
      ),
    ],
  });
}
