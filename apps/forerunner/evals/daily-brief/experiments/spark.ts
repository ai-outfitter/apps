// The DGX Spark's local model. Point BRIEF_EVAL_BASE_URL at its OpenAI-compatible
// endpoint and name its model in BRIEF_EVAL_SPARK_MODEL.
export default { model: process.env.BRIEF_EVAL_SPARK_MODEL ?? "GLM-5.3-Flash-EXL3" };
