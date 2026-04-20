import { z } from "zod";
import type { ActionDef } from "../registry.ts";
import { REGISTRY } from "../registry.ts";

const paramsSchema = z.object({}).strict();

export const listActions: ActionDef = {
  description: "Retorna o manifest com todas as acoes registradas, suas descricoes e schemas de params.",
  paramsSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (raw) => {
    paramsSchema.parse(raw);
    const actions = Object.entries(REGISTRY).map(([name, def]) => ({
      name,
      description: def.description,
      params_schema: def.paramsSchema,
    }));
    return { actions, count: actions.length };
  },
};
