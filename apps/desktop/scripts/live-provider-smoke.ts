/** Opt-in live QA. Reads encrypted profiles, never writes credentials or project content.
 * Each configured endpoint gets one catalog request and at most four tiny calls, no retries.
 * Only classifications/counts are recorded. Response text, keys and raw errors never leave memory.
 */
import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelGateway } from "../../../packages/core/src/gateway/gateway";
import type { EndpointConnection } from "../../../packages/core/src/gateway/connection";

type Stored = {
  providerId: string;
  baseUrl: string;
  model: string;
  encryptedApiKey: string;
  additionalFields?: Record<string, string>;
};
type Result = {
  provider: string;
  configured: boolean;
  model?: string;
  auth: string;
  discovery: string;
  chat: string;
  stream: string;
  tools: string;
  cancellation: string;
  health: string;
  errors: string[];
  calls: number;
};
const category = (error: unknown) =>
  error && typeof error === "object" && "category" in error
    ? String(error.category)
    : error instanceof Error && error.name === "AbortError"
      ? "CANCELLED"
      : "CONNECTION_ERROR";
const output = process.env.ALTREX_LIVE_REPORT;
const profilesPath = process.env.ALTREX_LIVE_PROFILES;
if (!output || !profilesPath || process.env.ALTREX_LIVE_SMOKE !== "1")
  throw new Error("Explicit live smoke configuration required");
app.setPath("userData", mkdtempSync(join(tmpdir(), "altrex-live-qa-")));
app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const results: Result[] = [];
  const save = () =>
    writeFileSync(
      output!,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          fixture: false,
          maxOutputTokens: 128,
          maxAttempts: 1,
          repositoryDataSent: false,
          results,
        },
        null,
        2,
      ),
    );
  try {
    const records: Stored[] = existsSync(profilesPath)
      ? JSON.parse(readFileSync(profilesPath, "utf8"))
      : [];
    for (const stored of records) {
      const result: Result = {
        provider: stored.providerId,
        configured: true,
        model: stored.model,
        auth: "NOT TESTED",
        discovery: "NOT TESTED",
        chat: "NOT TESTED",
        stream: "NOT TESTED",
        tools: "NOT TESTED",
        cancellation: "NOT TESTED",
        health: "NOT TESTED",
        errors: [],
        calls: 0,
      };
      results.push(result);
      let apiKey = "";
      try {
        apiKey = safeStorage.decryptString(
          Buffer.from(stored.encryptedApiKey, "base64"),
        );
      } catch {
        result.errors.push("CREDENTIAL_DECRYPT_FAILED");
        save();
        continue;
      }
      const connection: EndpointConnection = {
        providerId: stored.providerId,
        baseUrl: stored.baseUrl,
        model: stored.model,
        apiKey,
        ...(stored.additionalFields
          ? { additionalFields: stored.additionalFields }
          : {}),
      };
      const gateway = new ModelGateway();
      const policy = {
        outputTokens: 128,
        maxAttempts: 1,
        connectionMs: 10000,
        firstTokenMs: 20000,
        idleMs: 10000,
        overallMs: 30000,
      };
      let supportsTools: boolean | undefined;
      try {
        const catalog = await gateway.listModels(connection);
        result.discovery = `PASS (${catalog.length} models)`;
        supportsTools = catalog.find(
          (model) => model.id === stored.model,
        )?.supportsTools;
        if (!catalog.some((model) => model.id === stored.model))
          result.errors.push("CONFIGURED_MODEL_NOT_IN_CATALOG");
        // A public catalog is not proof that a key can generate output.
      } catch (error) {
        const code = category(error);
        result.discovery = "FAIL";
        result.errors.push(code);
        if (code === "AUTH_ERROR") {
          result.auth = "FAIL";
          save();
          continue;
        }
        if (code === "CONNECTION_ERROR") {
          result.health = "FAIL (unreachable)";
          save();
          continue;
        }
      }
      const run = async (stream: boolean) => {
        result.calls++;
        return gateway.run({
          connection,
          messages: [{ role: "user", content: "Reply with only the word OK." }],
          signal: AbortSignal.timeout(32000),
          stream,
          overrides: policy,
        });
      };
      try {
        const response = await run(false);
        result.chat = response.text.trim()
          ? "PASS"
          : "FAIL (no text within 128-token budget)";
        result.auth = "PASS";
      } catch (error) {
        const code = category(error);
        result.chat = "FAIL";
        result.errors.push(code);
        if (code === "AUTH_ERROR") result.auth = "FAIL";
        result.health = gateway.executor.health(connection).state;
        save();
        continue;
      }
      try {
        const response = await run(true);
        result.stream =
          response.streamed && response.text.trim()
            ? "PASS"
            : "FAIL (no streamed text within budget)";
      } catch (error) {
        result.stream = "FAIL";
        result.errors.push(category(error));
      }
      if (supportsTools === false) result.tools = "UNSUPPORTED (catalog)";
      else {
        try {
          result.calls++;
          const response = await gateway.run({
            connection,
            messages: [
              {
                role: "user",
                content:
                  'Call the qa_ping tool with value "ok". Do not reply with text.',
              },
            ],
            tools: [
              {
                type: "function",
                function: {
                  name: "qa_ping",
                  description: "An inert QA tool. It has no side effects.",
                  parameters: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                    additionalProperties: false,
                  },
                },
              },
            ],
            signal: AbortSignal.timeout(32000),
            stream: true,
            overrides: policy,
          });
          result.tools = response.toolCalls.some(
            (call) => call.name === "qa_ping",
          )
            ? "PASS"
            : "FAIL (no tool call within budget)";
        } catch (error) {
          result.tools = "FAIL";
          result.errors.push(category(error));
        }
      }
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 300);
      try {
        result.calls++;
        await gateway.run({
          connection,
          messages: [
            { role: "user", content: "Count from one to one hundred." },
          ],
          signal: controller.signal,
          stream: true,
          overrides: policy,
        });
        result.cancellation = "NOT TESTED (completed before cancellation)";
      } catch (error) {
        result.cancellation =
          controller.signal.aborted && category(error) === "CANCELLED"
            ? "PASS"
            : `FAIL (${category(error)})`;
      } finally {
        clearTimeout(timer);
      }
      result.health = gateway.executor.health(connection).state;
      connection.apiKey = "";
      apiKey = "";
      save();
      console.log(
        `[LIVE_QA] ${result.provider}: chat=${result.chat}; stream=${result.stream}; tools=${result.tools}; health=${result.health}`,
      );
    }
    save();
    app.quit();
  } catch {
    console.error(
      "[LIVE_QA] Harness failed; no secret or response data logged.",
    );
    save();
    app.exit(1);
  }
});
