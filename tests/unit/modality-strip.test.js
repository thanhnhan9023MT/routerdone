import { describe, it, expect } from "vitest";
import { stripUnsupportedModalities } from "../../open-sse/translator/concerns/modality.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const NO_VISION = { vision: false, audioInput: true, pdf: true };
const NO_AUDIO = { vision: true, audioInput: false, pdf: true };
const NO_PDF = { vision: true, audioInput: true, pdf: false };
const ALL = { vision: true, audioInput: true, pdf: true };
const VALID_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("stripUnsupportedModalities", () => {
  it("fast-exits when model supports all modalities", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI, ALL)).toBe(false);
    expect(body.messages[0].content).toHaveLength(1);
  });

  it("openai: passes image through when vision:false", () => {
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,xx" } };
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      image,
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_VISION);
    expect(body.messages[0].content).toContain(image);
    expect(body.messages[0].content.some((b) => /image omitted/.test(b.text || ""))).toBe(false);
  });

  it("openai: strips input_audio when audioInput:false", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "input_audio", input_audio: { data: "x", format: "wav" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO);
    expect(body.messages[0].content.some((b) => b.type === "input_audio")).toBe(false);
    expect(body.messages[0].content.some((b) => /audio omitted/.test(b.text || ""))).toBe(true);
  });

  it("openai: strips file when pdf:false", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "file", file: { filename: "d.pdf", file_data: "data:application/pdf;base64,x" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_PDF);
    expect(body.messages[0].content.some((b) => b.type === "file")).toBe(false);
  });

  it("openai: keeps image when vision:true", () => {
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO);
    expect(body.messages[0].content.some((b) => b.type === "image_url")).toBe(true);
  });

  it("openai: passes signature conflicts through to the provider", () => {
    const jpegAsPng = "data:image/png;base64,/9j/4AAQ";
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: jpegAsPng } },
    ] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO)).toBe(true);
    expect(body.messages[0].content.find((b) => b.type === "image_url")?.image_url.url).toBe(jpegAsPng);
  });

  it("openai: forwards non-image-bytes data URI (decode-only, no signature)", () => {
    // "QUJD" decodes to ASCII "ABC" — no image signature. Per relaxed policy,
    // we forward decodable data URIs rather than second-guessing the client.
    const body = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI, NO_AUDIO);
    expect(body.messages[0].content.some((b) => b.type === "image_url")).toBe(true);
  });

  it("openai: keeps an unpadded valid image data URI when vision:true", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII";
    const body = { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: imageUrl } },
    ] }] };

    expect(stripUnsupportedModalities(body, FORMATS.OPENAI, ALL)).toBe(false);
    expect(body.messages[0].content[0].image_url.url).toBe(imageUrl);
  });
  it("claude: passes image through while stripping unsupported document", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } };
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "hi" },
      image,
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "x" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.CLAUDE, { vision: false, audioInput: true, pdf: false });
    const types = body.messages[0].content.map((b) => b.type);
    expect(body.messages[0].content).toContain(image);
    expect(types).not.toContain("document");
  });

  it("gemini: passes inlineData image through when vision:false", () => {
    const image = { inlineData: { mimeType: "image/png", data: "x" } };
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }, image] }] };
    stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    expect(body.contents[0].parts).toContain(image);
    expect(body.contents[0].parts.some((p) => /image omitted/.test(p.text || ""))).toBe(false);
  });

  it("gemini: keeps inlineData image and pdf when supported", () => {
    const body = { contents: [{ role: "user", parts: [
      { inlineData: { mimeType: "image/png", data: "x" } },
      { inlineData: { mimeType: "application/pdf", data: "y" } },
    ] }] };
    stripUnsupportedModalities(body, FORMATS.GEMINI, NO_VISION);
    const mimes = body.contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData.mimeType);
    expect(mimes).toEqual(["image/png", "application/pdf"]);
  });

  it("antigravity: passes inline image through", () => {
    const image = { inlineData: { mimeType: "image/png", data: "x" } };
    const body = { request: { contents: [{ role: "user", parts: [image] }] } };
    stripUnsupportedModalities(body, FORMATS.ANTIGRAVITY, NO_VISION);
    expect(body.request.contents[0].parts).toContain(image);
  });

  it("responses: passes input_image through when vision:false", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,x" };
    const body = { input: [{ role: "user", content: [
      { type: "input_text", text: "hi" },
      image,
    ] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, NO_VISION);
    expect(body.input[0].content).toContain(image);
  });

  it("responses: passes output image through when vision:false", () => {
    const image = { type: "input_image", image_url: VALID_PNG };
    const body = { input: [{ type: "message", output: [image] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, NO_VISION);
    expect(body.input[0].output).toContain(image);
  });

  it("responses: passes opaque output image references through", () => {
    const image = { type: "input_image", image_url: "not-base64" };
    const body = { input: [{ type: "message", output: [image] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, ALL)).toBe(false);
    expect(body.input[0].output).toContain(image);
  });

  it("responses: passes opaque content image references through", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,invalid!" };
    const body = { input: [{ role: "user", content: [image] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, ALL)).toBe(false);
    expect(body.input[0].content).toContain(image);
  });

  it("responses: keeps valid output image_url when vision:true", () => {
    const body = { input: [{ type: "message", output: [
      { type: "input_image", image_url: VALID_PNG },
    ] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, ALL)).toBe(false);
    expect(body.input[0].output[0].image_url).toBe(VALID_PNG);
  });

  it("responses: passes signature conflicts through to the provider", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,/9j/4AAQ" };
    const body = { input: [{ role: "user", content: [image] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, ALL)).toBe(false);
    expect(body.input[0].content).toContain(image);
  });

  it("responses: forwards image/jpg JPEG data URI (alias regression)", () => {
    // Clients commonly send image/jpg; detected signature is image/jpeg.
    // The alias must accept it instead of silently dropping the image.
    const body = { input: [{ role: "user", content: [
      { type: "input_image", image_url: "data:image/jpg;base64,/9j/4AAQ" },
    ] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, ALL)).toBe(false);
    expect(body.input[0].content.some((b) => b.type === "input_image")).toBe(true);
  });

  it("responses: passes malformed base64 through to the provider", () => {
    const image = { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo==A" };
    const body = { input: [{ role: "user", content: [image] }] };
    stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, ALL);
    expect(body.input[0].content).toContain(image);
  });

  it("responses: keeps remote output image_url when vision:true", () => {
    const body = { input: [{ type: "message", output: [
      { type: "input_image", image_url: "https://example.com/a.png" },
    ] }] };
    expect(stripUnsupportedModalities(body, FORMATS.OPENAI_RESPONSES, ALL)).toBe(false);
    expect(body.input[0].output[0].image_url).toBe("https://example.com/a.png");
  });

  it("handles missing/empty body safely", () => {
    expect(stripUnsupportedModalities(null, FORMATS.OPENAI, NO_VISION)).toBe(false);
    expect(stripUnsupportedModalities({}, FORMATS.OPENAI, null)).toBe(false);
    expect(stripUnsupportedModalities({ messages: [] }, FORMATS.OPENAI, NO_VISION)).toBe(false);
  });
});
