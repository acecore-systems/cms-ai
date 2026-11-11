export function textSchema(
  request: Record<string, unknown>,
  responses = false,
) {
  const format = responses
    ? (request.text as any)?.format
    : (request.response_format as any);
  const schema = responses
    ? format?.schema
    : (format?.json_schema?.schema ?? format?.json_schema);
  if (
    !schema ||
    format?.type !== "json_schema" ||
    request.tools ||
    request.tool_choice ||
    request.stream === true
  )
    throw Error("seo_text_schema");
  return schema;
}
