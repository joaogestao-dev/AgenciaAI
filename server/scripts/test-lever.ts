/**
 * Smoke test ponta-a-ponta do canal Paperclip → Lever.
 *
 * Uso:
 *   tsx server/scripts/test-lever.ts manifest
 *   tsx server/scripts/test-lever.ts snapshot <client_id_uuid>
 *   tsx server/scripts/test-lever.ts create   <client_id_uuid>
 *   tsx server/scripts/test-lever.ts complete <task_id_uuid>
 *
 * Lê LEVER_INBOUND_URL, LEVER_INBOUND_BEARER, LEVER_ANON_KEY, LEVER_DEFAULT_ACTOR
 * do .env do Paperclip via dotenv (carregado pelo runner).
 */

// O .env mora na raiz do monorepo, não em server/. Carrega ambos os caminhos
// possíveis (root + cwd) para funcionar tanto rodando da raiz quanto de server/.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });
dotenv.config({ override: false });

import { randomUUID } from "node:crypto";
import {
  leverListActions,
  leverGetClientSnapshot,
  leverCreateClientTask,
  leverUpdateClientTaskStatus,
  isLeverClientConfigured,
  LeverClientError,
} from "../src/services/lever-client.js";

async function main(): Promise<void> {
  if (!isLeverClientConfigured()) {
    console.error(
      "Cliente Lever desabilitado. Configure LEVER_INBOUND_URL, LEVER_INBOUND_BEARER e LEVER_ANON_KEY no .env",
    );
    process.exit(2);
  }

  const [, , mode, arg] = process.argv;

  switch (mode) {
    case "manifest": {
      const out = await leverListActions({ idempotencyKey: `smoke_manifest_${randomUUID()}` });
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    case "snapshot": {
      if (!arg) throw new Error("uso: snapshot <client_id_uuid>");
      const out = await leverGetClientSnapshot(
        { client_id: arg },
        { idempotencyKey: `smoke_snapshot_${randomUUID()}` },
      );
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    case "create": {
      if (!arg) throw new Error("uso: create <client_id_uuid>");
      const idempotencyKey = `smoke_create_${randomUUID()}`;
      const out = await leverCreateClientTask(
        {
          client_id: arg,
          title: `[smoke-test] ${new Date().toISOString()}`,
          description: "Tarefa criada pelo smoke test do Paperclip. Pode deletar.",
          priority: "low",
          area: "strategy",
        },
        { idempotencyKey },
      );
      console.log(JSON.stringify(out, null, 2));
      console.log(`\nIdempotency key: ${idempotencyKey}`);
      console.log(`Reexecute o mesmo create com a mesma key — deve retornar replay.`);
      return;
    }

    case "complete": {
      if (!arg) throw new Error("uso: complete <task_id_uuid>");
      const out = await leverUpdateClientTaskStatus(
        { task_id: arg, status: "completed" },
        { idempotencyKey: `smoke_complete_${randomUUID()}` },
      );
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    default:
      console.error("Modos: manifest | snapshot <id> | create <id> | complete <id>");
      process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof LeverClientError) {
    console.error(
      `LeverClientError [${err.code}] (HTTP ${err.httpStatus}) em '${err.action}': ${err.message}`,
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
