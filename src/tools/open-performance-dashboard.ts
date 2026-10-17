import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { openBrowser as defaultOpenBrowser } from "../auth/oauth.js";
import { createDashboardApi } from "../dashboard/api.js";
import {
  DASHBOARD_IDLE_MS,
  startDashboardServer,
  type DashboardServer,
  type DashboardServerOptions,
} from "../dashboard/server.js";

export const DASHBOARD_VIEWS = [
  "today",
  "session",
  "hyrox",
  "triathlon",
  "readiness",
  "audit",
] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const openPerformanceDashboardInputSchema = z.object({
  view: z
    .enum(DASHBOARD_VIEWS)
    .optional()
    .describe("Tab to open first. Default 'session' (latest HYROX session report)."),
});

export const openPerformanceDashboardOutputSchema = z.object({
  url: z.string(),
  view: z.enum(DASHBOARD_VIEWS),
  reused: z.boolean(),
  browser_opened: z.boolean(),
  expires_after_idle_minutes: z.number(),
  note: z.string(),
});
export type OpenPerformanceDashboardOutput = z.infer<typeof openPerformanceDashboardOutputSchema>;

export interface DashboardControllerOptions {
  client: WhoopClient;
  directory?: string;
  openBrowser?: (url: string) => void;
  staticDir?: string;
  idleMs?: number;
}

export interface DashboardController {
  open(
    params: z.infer<typeof openPerformanceDashboardInputSchema>
  ): Promise<OpenPerformanceDashboardOutput>;
  close(): Promise<void>;
}

/**
 * Starts the loopback dashboard on first use and reuses it afterwards. Each call rotates the
 * session token, so only the most recently opened tab can call the API.
 */
export function createDashboardController(
  options: DashboardControllerOptions
): DashboardController {
  const idleMs = options.idleMs ?? DASHBOARD_IDLE_MS;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  let running: Promise<DashboardServer> | undefined;

  const start = (): Promise<DashboardServer> => {
    const serverOptions: DashboardServerOptions = {
      api: createDashboardApi({
        client: options.client,
        ...(options.directory ? { directory: options.directory } : {}),
      }),
      idleMs,
      onClose: () => {
        running = undefined;
      },
      ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    };
    const pending = startDashboardServer(serverOptions);
    pending.catch(() => {
      running = undefined;
    });
    return pending;
  };

  return {
    async open(params) {
      const view = params.view ?? "session";
      const reused = running !== undefined;
      running ??= start();
      const server = await running;
      const token = reused ? server.rotateToken() : server.token();
      // Token in the fragment (never sent to the server or logged); no '&' so the
      // URL survives `cmd /c start` on Windows.
      const url = `${server.origin}/?view=${view}#token=${token}`;
      let browserOpened = true;
      try {
        openBrowser(url);
      } catch {
        browserOpened = false;
      }
      return {
        url,
        view,
        reused,
        browser_opened: browserOpened,
        expires_after_idle_minutes: Math.round(idleMs / 60_000),
        note: "Dashboard runs on 127.0.0.1 only and stops after the idle period. The link is single-session: opening the dashboard again invalidates older links.",
      };
    },
    async close() {
      const pending = running;
      running = undefined;
      if (pending) await (await pending).close();
    },
  };
}
