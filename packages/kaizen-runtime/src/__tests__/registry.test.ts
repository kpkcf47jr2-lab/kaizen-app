import { describe, it, expect } from "vitest";
import {
  REGISTRY_ABI,
  KAIROS_AGENT_REGISTRY_ADDRESSES,
  registryAddressFor,
  setRegistryAddressForTests,
  NoopAgentRegistry,
} from "../registry/index.js";
import type { ModuleConfig } from "../types.js";

const cfg: ModuleConfig = {
  agentId: "agt_reg",
  runtimeVersion: "0.1.0-alpha.0",
  readOnly: true,
  killSwitchEnv: "KAIZEN_KILL_REG",
};

describe("KairosAgentRegistry ABI + address book", () => {
  it("ABI covers the 4 read + 2 write + 2 event signatures we depend on", () => {
    const joined = REGISTRY_ABI.join("|");
    // writes
    expect(joined).toContain("register(address parentAddress");
    expect(joined).toContain("updateAgentCard(string");
    // reads
    expect(joined).toContain("isRegistered(address");
    expect(joined).toContain("entryOf(address");
    expect(joined).toContain("childCount(address");
    expect(joined).toContain("childrenOf(address");
    expect(joined).toContain("totalRegistered");
    // events
    expect(joined).toContain("event Registered");
    expect(joined).toContain("event AgentCardUpdated");
  });

  it("registryAddressFor throws for unset chains + succeeds after set", () => {
    // Base Sepolia (84532) starts null in Fase 5.
    expect(() => registryAddressFor(84532)).toThrow(/not deployed on chain 84532/);
    setRegistryAddressForTests(84532, "0x1111111111111111111111111111111111111111");
    expect(registryAddressFor(84532)).toBe("0x1111111111111111111111111111111111111111");
    setRegistryAddressForTests(84532, null);  // restore
  });

  it("address book has entries for the chains we plan to deploy on", () => {
    expect(Object.keys(KAIROS_AGENT_REGISTRY_ADDRESSES).map(Number)).toEqual(
      expect.arrayContaining([8453, 84532, 137]),
    );
  });
});

describe("NoopAgentRegistry (preserved as fallback)", () => {
  it("register throws with a specific error mentioning Fase 5", async () => {
    const noop = new NoopAgentRegistry(cfg);
    await expect(
      noop.register({
        agentId: "x", address: "0x0", parentAddress: null,
        constitutionSha256: "0", agentCardUri: "https://",
      }),
    ).rejects.toThrow(/Fase 5/);
  });

  it("lookup returns null (safe read)", async () => {
    const noop = new NoopAgentRegistry(cfg);
    expect(await noop.lookup("0x0")).toBeNull();
  });
});
