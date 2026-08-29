// SPDX-License-Identifier: BUSL-1.1
// Kaizen LLC — 2026-08-28
pragma solidity ^0.8.24;

/**
 * @title KairosAgentRegistry
 * @author Kaizen LLC
 * @notice Immutable, deploy-once registry for Kaizen autonomous agents.
 *
 * Design principles:
 *  - Self-registration: an agent calls register() from its own wallet.
 *    The wallet address IS the agent identity. No admin, no minter.
 *  - Each entry stores: parent link, constitution hash, agent-card URI,
 *    creation block. Once registered, only the agent itself can update
 *    its agent-card URI. Every other field is immutable.
 *  - Parent linkage is a lightweight tree — an on-chain children lookup
 *    is provided so a parent can discover its own descendants after a
 *    restart, without off-chain state.
 *  - Deliberate NON-goals: reputation scores (owner will add off-chain),
 *    on-chain messaging (use the runtime inbox), upgrades (redeploy new
 *    version instead of proxying).
 *
 * Compliance note:
 *  Registration is intentionally cheap (single SSTORE per new agent +
 *  one children-array push). It costs the agent its own gas — this is
 *  the point (an agent must earn or receive enough native to exist).
 */
contract KairosAgentRegistry {
    // ────────────────────────────────────────────────────────────────
    //   State
    // ────────────────────────────────────────────────────────────────

    struct Entry {
        address parentAddress;          // zero for root agents
        bytes32 constitutionSha256;     // hash of the agent's constitution file
        string  agentCardUri;           // https URL to a JSON agent card
        uint64  createdBlock;
        uint64  createdAt;              // block.timestamp
        bool    exists;
    }

    /** wallet address => Entry */
    mapping(address => Entry) private _entries;

    /** parent address => list of registered children addresses */
    mapping(address => address[]) private _childrenOf;

    /** Contract-level immutable: total registrations. Read-only. */
    uint256 public totalRegistered;

    // ────────────────────────────────────────────────────────────────
    //   Events
    // ────────────────────────────────────────────────────────────────

    event Registered(
        address indexed agent,
        address indexed parent,
        bytes32 indexed constitutionSha256,
        string  agentCardUri,
        uint256 createdBlock,
        uint256 createdAt
    );

    event AgentCardUpdated(
        address indexed agent,
        string  newAgentCardUri
    );

    // ────────────────────────────────────────────────────────────────
    //   Errors
    // ────────────────────────────────────────────────────────────────

    error AlreadyRegistered();
    error UnknownAgent();
    error EmptyCardUri();
    error ParentSelfLoop();

    // ────────────────────────────────────────────────────────────────
    //   Public writes
    // ────────────────────────────────────────────────────────────────

    /**
     * @notice Register msg.sender as a Kaizen agent.
     * @param parentAddress The parent agent's wallet. Zero for root agents.
     * @param constitutionSha256 SHA-256 of the constitution the agent runs.
     * @param agentCardUri HTTPS URL to a JSON agent card (name, tools, contact).
     */
    function register(
        address parentAddress,
        bytes32 constitutionSha256,
        string calldata agentCardUri
    ) external {
        if (_entries[msg.sender].exists) revert AlreadyRegistered();
        if (parentAddress == msg.sender) revert ParentSelfLoop();
        if (bytes(agentCardUri).length == 0) revert EmptyCardUri();

        _entries[msg.sender] = Entry({
            parentAddress: parentAddress,
            constitutionSha256: constitutionSha256,
            agentCardUri: agentCardUri,
            createdBlock: uint64(block.number),
            createdAt: uint64(block.timestamp),
            exists: true
        });

        if (parentAddress != address(0)) {
            _childrenOf[parentAddress].push(msg.sender);
        }

        unchecked { totalRegistered += 1; }

        emit Registered(
            msg.sender,
            parentAddress,
            constitutionSha256,
            agentCardUri,
            block.number,
            block.timestamp
        );
    }

    /**
     * @notice Update the agent card URI. Only the agent itself may call.
     *         Everything else (parent link, constitution hash, timestamps)
     *         is immutable — a new constitution requires a new agent.
     */
    function updateAgentCard(string calldata newAgentCardUri) external {
        Entry storage e = _entries[msg.sender];
        if (!e.exists) revert UnknownAgent();
        if (bytes(newAgentCardUri).length == 0) revert EmptyCardUri();
        e.agentCardUri = newAgentCardUri;
        emit AgentCardUpdated(msg.sender, newAgentCardUri);
    }

    // ────────────────────────────────────────────────────────────────
    //   Public reads
    // ────────────────────────────────────────────────────────────────

    /** True iff `agent` is registered. */
    function isRegistered(address agent) external view returns (bool) {
        return _entries[agent].exists;
    }

    /** Full entry for an agent. Reverts on unknown so callers cannot
     *  silently rely on default-zero fields.  */
    function entryOf(address agent) external view returns (Entry memory) {
        Entry memory e = _entries[agent];
        if (!e.exists) revert UnknownAgent();
        return e;
    }

    /** Number of children registered under a parent. Zero for leaves
     *  and non-parents alike. */
    function childCount(address parent) external view returns (uint256) {
        return _childrenOf[parent].length;
    }

    /** Bounded children fetch — page-friendly. Caller supplies offset
     *  and limit so on-chain reads never scale badly. */
    function childrenOf(address parent, uint256 offset, uint256 limit)
        external view returns (address[] memory)
    {
        address[] storage all = _childrenOf[parent];
        uint256 len = all.length;
        if (offset >= len) return new address[](0);
        uint256 end = offset + limit;
        if (end > len) end = len;
        address[] memory out = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = all[i];
        }
        return out;
    }
}
