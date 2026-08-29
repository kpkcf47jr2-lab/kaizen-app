import { describe, it, expect } from "vitest";
import { InMemorySkillsRegistry, type SkillManifest } from "../skills/index.js";

const CONST_HASH = "31f0a948de7a7130bf68414486bde65e8d33c3b51d6f573704986a5db187ab38";

function makeManifest(name = "shopify-basic", hash = CONST_HASH): SkillManifest {
  return {
    name, version: "0.1.0",
    description: "test",
    constitutionSha256: hash,
    permissions: { categories: ["commerce"], externalHosts: ["*.myshopify.com"] },
    entrypoint: "./index.js",
  };
}

describe("InMemorySkillsRegistry", () => {
  it("registerFixture + install round-trip works with matching hash", async () => {
    const reg = new InMemorySkillsRegistry({
      approvedSources: ["https://github.com/kaizen-777/skills"],
      expectedConstitutionSha256: CONST_HASH,
    });
    reg.registerFixture("https://github.com/kaizen-777/skills", makeManifest(), [
      { name: "shopify.createProduct", description: "d", parameters: {} },
    ]);
    const skill = await reg.install("https://github.com/kaizen-777/skills");
    expect(skill.manifest.name).toBe("shopify-basic");
    expect(skill.tools).toHaveLength(1);
  });

  it("refuses registerFixture when source not approved", () => {
    const reg = new InMemorySkillsRegistry({
      approvedSources: ["https://github.com/kaizen-777/skills"],
      expectedConstitutionSha256: CONST_HASH,
    });
    expect(() => reg.registerFixture("https://evil.example.com/x", makeManifest(), []))
      .toThrow(/not in approved list/);
  });

  it("refuses registerFixture on constitution hash mismatch", () => {
    const reg = new InMemorySkillsRegistry({
      approvedSources: ["https://github.com/kaizen-777/skills"],
      expectedConstitutionSha256: CONST_HASH,
    });
    expect(() => reg.registerFixture("https://github.com/kaizen-777/skills", makeManifest("x", "deadbeef"), []))
      .toThrow(/constitution SHA mismatch/);
  });

  it("install throws for non-fixture sources (Fase 8 will add real download)", async () => {
    const reg = new InMemorySkillsRegistry({
      approvedSources: ["https://github.com/kaizen-777/skills"],
      expectedConstitutionSha256: CONST_HASH,
    });
    await expect(reg.install("https://github.com/kaizen-777/skills")).rejects.toThrow(/not pre-registered/);
  });

  it("quarantine + install refuses the quarantined skill", async () => {
    const reg = new InMemorySkillsRegistry({
      approvedSources: ["https://github.com/kaizen-777/skills"],
      expectedConstitutionSha256: CONST_HASH,
    });
    reg.registerFixture("https://github.com/kaizen-777/skills", makeManifest(), []);
    await reg.quarantine("shopify-basic", "test-quarantine");
    await expect(reg.install("https://github.com/kaizen-777/skills")).rejects.toThrow(/quarantined/);
  });

  it("uninstall removes the skill", async () => {
    const reg = new InMemorySkillsRegistry({
      approvedSources: ["https://github.com/kaizen-777/skills"],
      expectedConstitutionSha256: CONST_HASH,
    });
    reg.registerFixture("https://github.com/kaizen-777/skills", makeManifest(), []);
    expect((await reg.list()).length).toBe(1);
    await reg.uninstall("shopify-basic");
    expect((await reg.list()).length).toBe(0);
  });
});
