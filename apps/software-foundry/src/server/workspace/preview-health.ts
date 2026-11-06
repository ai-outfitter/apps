import { z } from "zod";

/** Workers and gateways roll out independently. An older gateway refuses the
 * new operation with 400; keep the existing attempt waiting during that rollout. */
export function gatewayPreviewRequest(control: (input: { operation: string; url: string }) => Promise<unknown>) {
  return async (url: string) => {
    let receipt: unknown;
    try { receipt = await control({ operation: "inspect-preview", url: new URL(url).origin }); }
    catch (error) {
      if (error instanceof Response && error.status === 400)
        return new Response(null, { status: 503 });
      throw error;
    }
    const result = z.object({ status: z.number().int().min(200).max(599),
      health: z.object({ status: z.string(), revision: z.string().optional() }).optional(),
    }).parse(receipt);
    return new Response(result.health ? JSON.stringify(result.health) : null, { status: result.status });
  };
}
