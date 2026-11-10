/** The real telemetry adapter on a bare page, for the spec that runs in every browser engine. */
import { startTelemetry } from "../lib/telemetry/browser.ts";

const started = startTelemetry(`${location.origin}/v1/events`);
(window as unknown as { graftTelemetry: unknown }).graftTelemetry = started?.telemetry ?? null;
