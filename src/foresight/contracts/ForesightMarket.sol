// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// The parimutuel market, and the one-shot contract that resolves it.
//
// Compiled by `scripts/compile-contracts.mjs` into `src/contracts/generated.ts`, which is
// COMMITTED: the service runs under tsx with no build step to hang a compile on, and bytecode in
// git is bytecode a reviewer can diff. CI recompiles and fails on any difference, so the committed
// artefact and the source below cannot drift. Same discipline as `micro-mint`.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// PARIMUTUEL, DELIBERATELY. NO ORDER BOOK, NO AMM, NO LIQUIDITY PROVISIONING.
//
// Everyone backing an outcome shares one pool. The odds are the pool ratio and nothing else; the
// payout is pro-rata out of the total. There is no market maker to be adversely selected, no
// liquidity to provision and no impermanent-loss surface, because there is no inventory anywhere.
// A CPMM is a v2 decision to be taken with real usage in front of it — 19-new-products.md §2.2.
//
// The consequence worth stating plainly to a bettor: **your odds are not fixed when you stake.**
// They are whatever the final pool ratio turns out to be. That is a property of parimutuel, it is
// how every racetrack tote in the world works, and the front end has to show it rather than hide
// it.
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// ## Binary, in v1
//
// Two outcomes: YES and NO. Not a limitation the arithmetic needs — an N-outcome parimutuel is the
// same three lines — but a limitation on what an operator may write. A binary question with a
// named source has exactly one right answer at close; a five-way question invites a resolution
// argument, and a resolution argument is the failure mode this whole design is built to avoid.
//
// ## What the service can and cannot do to this contract
//
// Nothing. There is no owner, no admin, no pause, no upgrade path and no withdrawal that is not a
// claim. The service's addresses appear here twice: `oracle`, which may only ever move the market
// to `Resolved` or `Void` and can never move a wei to itself, and `treasury`, which is a
// destination and holds no rights at all. A total compromise of this service cannot take a stake,
// cannot redirect a payout and cannot stop a winner claiming.

/// The action the oracle key is authorising. Deliberately a closed set of three.
/// @dev 0 = the market resolved YES, 1 = the market resolved NO, 2 = the market is void.
interface IForesightMarket {
    function oracleAct(uint8 action, uint64 oracleNonce) external;
}

contract ForesightMarket {
    /* ------------------------------------------------------------------ types */

    enum Status {
        Open,
        Resolved,
        Void
    }

    uint8 internal constant ACTION_RESOLVE_YES = 0;
    uint8 internal constant ACTION_RESOLVE_NO = 1;
    uint8 internal constant ACTION_VOID = 2;

    uint8 public constant OUTCOME_YES = 0;
    uint8 public constant OUTCOME_NO = 1;

    /// Basis points denominator. 10_000 bps = 100%.
    uint16 internal constant BPS = 10_000;
    /// A ceiling on the settlement fee, in the code rather than in a deploy script. An operator
    /// who could set 100% could take the whole losing pool, and a market that could do that is a
    /// market nobody should stake in. 10% is already far above what this will ever charge.
    uint16 internal constant MAX_FEE_BPS = 1_000;

    /* ------------------------------------------------------------------ immutables */

    /**
     * The key that may resolve or void this market. A custody-held address; this service never
     * holds it and never sees it.
     *
     * See `_isOracle` for why a contract created BY this address counts as this address.
     */
    address public immutable oracle;

    /// Where the settlement fee goes. A destination and nothing more — it has no rights here.
    address public immutable treasury;

    /**
     * keccak256 of the canonical market document: the question, the resolution criteria, the
     * NAMED RESOLUTION SOURCE, the close time and the dispute window, serialised by
     * `src/questiondoc.ts` and hashed there.
     *
     * **This is what makes resolution honesty structural rather than promised.** The source is
     * named at open and committed to the chain at open. An operator who wanted to pick a friendlier
     * source at resolution time would have to change a document whose hash is already immutable in
     * a contract holding other people's money, and anybody can notice.
     */
    bytes32 public immutable questionHash;

    /// No stake is accepted at or after this time. Unix seconds.
    uint64 public immutable closeTime;

    /**
     * How long after `resolve` before a claim may be made.
     *
     * The window is the whole of the dispute mechanism at the contract level, and that is
     * deliberate: an on-chain dispute *court* is a governance system, and a governance system is a
     * much larger thing to get wrong than a prediction market. What the window buys is the only
     * property that matters — a wrong resolution is visible, and the money has not moved yet, so
     * an operator can void the market instead. `oracleAct` accepts `Void` right up to the moment
     * the first claim is possible.
     */
    uint64 public immutable disputeWindowSeconds;

    /// Basis points of the LOSING pool taken on settlement. See `feeAmount`.
    uint16 public immutable feeBps;

    /* ------------------------------------------------------------------ state */

    Status public status;

    /// Set when `status == Resolved`. Meaningless otherwise; read it through `outcome()`.
    uint8 public winningOutcome;

    /// When `resolve` landed. The dispute window is measured from here.
    uint64 public resolvedAt;

    /// Total staked per outcome, in wei. `pool[0] + pool[1]` is the market's whole liability.
    uint256[2] public pool;

    /// Per-staker, per-outcome. The mirror in Postgres is a copy of this and nothing more.
    mapping(address => uint256[2]) internal _stakes;

    /// A claim is once, per address, for ever. See `claim`.
    mapping(address => bool) public claimed;

    /// How much of the WINNING pool has been claimed. `sweepDust` is gated on this reaching `pool`.
    uint256 public winningStakeClaimed;

    /// True once the settlement fee has been paid to the treasury. Paid exactly once.
    bool public feePaid;

    /* ------------------------------------------------------------------ events */

    event Staked(address indexed staker, uint8 indexed outcome, uint256 amount, uint256 poolYes, uint256 poolNo);
    event Resolved(uint8 indexed outcome, uint64 resolvedAt);
    event Voided(uint64 voidedAt);
    event Claimed(address indexed staker, uint256 amount, bool refund);
    event FeePaid(address indexed treasury, uint256 amount);
    event DustSwept(address indexed treasury, uint256 amount);

    /* ------------------------------------------------------------------ errors */

    error NotOracle();
    error NotOpen();
    error Closed();
    error NotYetClosed();
    error BadOutcome();
    error ZeroStake();
    error AlreadyClaimed();
    error NothingToClaim();
    error DisputeWindowOpen();
    error NotResolved();
    error FeeAlreadyPaid();
    error FeeNotPaid();
    error WinnersOutstanding();
    error TransferFailed();
    error BadConstruction();

    /* ------------------------------------------------------------------ construction */

    constructor(
        address oracle_,
        address treasury_,
        bytes32 questionHash_,
        uint64 closeTime_,
        uint64 disputeWindowSeconds_,
        uint16 feeBps_
    ) {
        // Every one of these is a market that could never work, caught at creation rather than at
        // the first stake. A market with no oracle can never resolve; a market whose close time is
        // already past can never take a stake; a fee above the ceiling is not a fee.
        if (oracle_ == address(0) || treasury_ == address(0)) revert BadConstruction();
        if (questionHash_ == bytes32(0)) revert BadConstruction();
        if (closeTime_ <= block.timestamp) revert BadConstruction();
        if (feeBps_ > MAX_FEE_BPS) revert BadConstruction();

        oracle = oracle_;
        treasury = treasury_;
        questionHash = questionHash_;
        closeTime = closeTime_;
        disputeWindowSeconds = disputeWindowSeconds_;
        feeBps = feeBps_;
        status = Status.Open;
    }

    /* ------------------------------------------------------------------ staking */

    /**
     * Back an outcome with EMBER. **The stake goes wallet → this contract.** It never touches the
     * service, which is why a total compromise of the service cannot take it.
     */
    function stake(uint8 outcome) external payable {
        if (status != Status.Open) revert NotOpen();
        if (block.timestamp >= closeTime) revert Closed();
        if (outcome > OUTCOME_NO) revert BadOutcome();
        if (msg.value == 0) revert ZeroStake();

        // `+=` on a uint256 in ^0.8 reverts on overflow, so the pool total is exact or the
        // transaction does not happen. There is no path here that truncates or rounds.
        _stakes[msg.sender][outcome] += msg.value;
        pool[outcome] += msg.value;

        emit Staked(msg.sender, outcome, msg.value, pool[OUTCOME_YES], pool[OUTCOME_NO]);
    }

    /// A plain send is not a stake. Refusing it is kinder than silently keeping it.
    receive() external payable {
        revert ZeroStake();
    }

    /* ------------------------------------------------------------------ resolution */

    /**
     * The one privileged entry point, and it can only ever set an outcome.
     *
     * `oracleNonce` is ignored when the caller IS the oracle address; it exists for the case where
     * the caller is a contract the oracle created. See `_isOracle`.
     */
    function oracleAct(uint8 action, uint64 oracleNonce) external {
        if (!_isOracle(oracleNonce)) revert NotOracle();
        if (status != Status.Open) revert NotOpen();

        if (action == ACTION_VOID) {
            // Void is available at any time, including before close. That is the point of it: a
            // market whose named source has disappeared, or which policy has pulled, must be
            // refundable the moment that is known rather than at some later ceremony.
            status = Status.Void;
            emit Voided(uint64(block.timestamp));
            return;
        }

        // RESOLUTION BEFORE CLOSE IS IMPOSSIBLE. Not discouraged — impossible. A market resolved
        // while it is still taking stakes is a market in which the resolver can stake on the
        // answer it is about to write.
        if (block.timestamp < closeTime) revert NotYetClosed();
        if (action > ACTION_RESOLVE_NO) revert BadOutcome();

        uint8 outcome = action == ACTION_RESOLVE_YES ? OUTCOME_YES : OUTCOME_NO;

        // A market nobody won REFUNDS EVERYBODY. The alternative — the whole pool to the treasury
        // because no ticket matched — is a windfall taken from people who were all wrong together,
        // and no honest tote does it. This also removes a division by zero from `claim`.
        if (pool[outcome] == 0) {
            status = Status.Void;
            emit Voided(uint64(block.timestamp));
            return;
        }

        status = Status.Resolved;
        winningOutcome = outcome;
        resolvedAt = uint64(block.timestamp);
        emit Resolved(outcome, resolvedAt);
    }

    /**
     * Is this caller the oracle key, directly or as a contract that key created?
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * WHY THE SECOND FORM EXISTS, WHICH IS THE ONE SURPRISING THING IN THIS FILE.
     *
     * The oracle key lives in `micro-custody`, and custody is a signing POLICY rather than a
     * signing oracle: an EVM address of purpose `deployer` may sign a zero-value contract CREATION
     * and nothing else (`custody/src/signing.ts:210-231`, `custody/src/gates.ts:52`). There is no
     * purpose in custody today whose EVM shape is "call a contract with calldata" — `transfer`
     * requires `data` to be empty (`custody/src/signing.ts:248-251`) and says in terms that
     * widening it is refused because it would turn the treasury key into a signing oracle. That
     * refusal is right, and it is not this repository's to overturn.
     *
     * So the oracle acts the only way custody will let it act: it CREATES a one-shot contract
     * (`ForesightResolver`, below) whose constructor calls this function and which then has no code
     * at all. What arrives here is therefore a contract address, not the oracle's.
     *
     * The check is exact, not a heuristic. A contract created by an EOA lands at
     * `keccak256(rlp([sender, nonce]))[12:]`, and only the account `sender` can ever produce a
     * contract there, for any nonce, ever. So `msg.sender == createAddress(oracle, n)` for a nonce
     * the caller supplies is EXACTLY as strong a statement as `msg.sender == oracle`: nobody else
     * can satisfy it. The caller cannot lie about the nonce, because a wrong nonce derives a
     * different address and the comparison fails.
     *
     * The direct form is kept and listed first because it is what a human operator with a hardware
     * wallet would use, and because if custody ever gains a call shape this contract needs no
     * change to take advantage of it.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     */
    function _isOracle(uint64 oracleNonce) internal view returns (bool) {
        if (msg.sender == oracle) return true;
        return msg.sender == computeCreateAddress(oracle, oracleNonce);
    }

    /**
     * `keccak256(rlp([deployer, nonce]))[12:]` — where a contract created by `deployer` at `nonce`
     * lands.
     *
     * RLP for this one shape only. The list holds a 20-byte string and a small integer, so the
     * payload is at most 21 + 9 = 30 bytes and the list header is always the single byte
     * `0xc0 + length`. The three nonce cases are RLP's own: zero is the empty string `0x80`, a
     * value below 0x80 is its own encoding, and anything larger is a length-prefixed big-endian
     * minimal-byte string.
     *
     * `micro-mint`'s `src/evm.ts:129` is the same derivation in TypeScript, and
     * `contracts.test.ts` asserts the two agree on a corpus — including the boundary at 0x7f/0x80
     * where a naive implementation produces the wrong address and nobody notices until a live
     * resolution reverts.
     */
    function computeCreateAddress(address deployer, uint64 nonce) public pure returns (address) {
        bytes memory encoded;
        if (nonce == 0) {
            // 0xd6 = 0xc0 + 22: one 21-byte address item plus one 1-byte nonce item.
            encoded = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x80));
        } else if (nonce <= 0x7f) {
            encoded = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(nonce));
        } else {
            uint256 length = _byteLength(nonce);
            encoded = abi.encodePacked(
                bytes1(uint8(0xc0 + 21 + 1 + length)),
                bytes1(0x94),
                deployer,
                bytes1(uint8(0x80 + length)),
                _minimalBytes(nonce, length)
            );
        }
        return address(uint160(uint256(keccak256(encoded))));
    }

    function _byteLength(uint64 value) private pure returns (uint256 length) {
        while (value != 0) {
            length++;
            value >>= 8;
        }
    }

    function _minimalBytes(uint64 value, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[length - 1 - i] = bytes1(uint8(value >> (8 * i)));
        }
    }

    /* ------------------------------------------------------------------ money out */

    /// Total staked across both outcomes. The contract's whole liability while it is open.
    function total() public view returns (uint256) {
        return pool[OUTCOME_YES] + pool[OUTCOME_NO];
    }

    /// What `msg.sender` has on each outcome. The public read the position mirror is a copy of.
    function stakeOf(address staker) external view returns (uint256 yes, uint256 no) {
        return (_stakes[staker][OUTCOME_YES], _stakes[staker][OUTCOME_NO]);
    }

    /**
     * Odds, as the pool ratio, in basis points. `oddsBps(YES)` is the share of the pool on YES.
     *
     * Not a price and not a probability the platform is asserting — it is arithmetic on two
     * numbers anybody can read off the chain, which is exactly what parimutuel odds are.
     */
    function oddsBps(uint8 outcome) external view returns (uint16) {
        if (outcome > OUTCOME_NO) revert BadOutcome();
        uint256 t = total();
        if (t == 0) return 0;
        return uint16((pool[outcome] * BPS) / t);
    }

    /**
     * The settlement fee, in wei. **Taken from the LOSING pool only.**
     *
     * That is a stronger promise than "a fee on winning pools" and it is the one worth making: a
     * winner always receives at least their own stake back, because the fee is charged against
     * other people's losses and never against their principal. A fee taken off the top would mean
     * a market with a 99% favourite pays its winners less than they put in, which reads as a bug
     * to every one of them.
     *
     * Zero on `Void`, always, and zero while the market is open. **Refunds are whole** —
     * 19-new-products.md §2.5.
     */
    function feeAmount() public view returns (uint256) {
        if (status != Status.Resolved) return 0;
        uint256 losing = pool[1 - winningOutcome];
        return (losing * feeBps) / BPS;
    }

    /// The pot the winners divide: everything staked, less the fee.
    function distributable() public view returns (uint256) {
        return total() - feeAmount();
    }

    /// When a claim first becomes possible. Zero while the market is open.
    function claimableFrom() public view returns (uint64) {
        if (status == Status.Void) return uint64(block.timestamp);
        if (status != Status.Resolved) return 0;
        return resolvedAt + disputeWindowSeconds;
    }

    /**
     * What `staker` is owed, right now. Zero once they have claimed.
     *
     * Resolved: `stake_on_winner * distributable / winning_pool`, floored. Void: everything they
     * put in, on both sides, exactly.
     */
    function payoutOf(address staker) public view returns (uint256) {
        if (claimed[staker]) return 0;
        if (status == Status.Void) {
            return _stakes[staker][OUTCOME_YES] + _stakes[staker][OUTCOME_NO];
        }
        if (status != Status.Resolved) return 0;
        uint256 backed = _stakes[staker][winningOutcome];
        if (backed == 0) return 0;
        // `pool[winningOutcome]` is non-zero: `oracleAct` voids rather than resolves a market with
        // an empty winning pool, so this division cannot be by zero.
        return (backed * distributable()) / pool[winningOutcome];
    }

    /**
     * Take a payout. Once, per address, for ever.
     *
     * ══════════════════════════════════════════════════════════════════════════════════════════
     * **THIS FUNCTION IS WHY THE MIRROR IS ALLOWED TO DIE.** It reads nothing but this contract's
     * own storage. If every server this platform owns is switched off, a winner with a wallet and
     * a block explorer can still be paid, and nobody has to ask anybody's permission.
     * ══════════════════════════════════════════════════════════════════════════════════════════
     *
     * `claimFor` is the same function pointed at somebody else — a batching convenience a leased
     * job may broadcast, whose failure costs nobody anything because the winner can always call
     * `claim` themselves.
     */
    function claim() external {
        _claim(msg.sender);
    }

    function claimFor(address staker) external {
        _claim(staker);
    }

    function _claim(address staker) internal {
        if (status == Status.Open) revert NotResolved();
        if (status == Status.Resolved && block.timestamp < resolvedAt + disputeWindowSeconds) {
            revert DisputeWindowOpen();
        }
        // DOUBLE CLAIM IS IMPOSSIBLE, and it is impossible here rather than by balance arithmetic
        // that happens to come out at zero. The flag is set BEFORE the transfer — the whole of the
        // reentrancy defence, and sufficient because there is no other state this function reads
        // after it.
        if (claimed[staker]) revert AlreadyClaimed();

        uint256 amount = payoutOf(staker);
        if (amount == 0) revert NothingToClaim();

        claimed[staker] = true;
        bool refund = status == Status.Void;
        if (!refund) {
            // Tracked so `sweepDust` can tell "every winner has been paid" from "somebody has not
            // claimed yet", without which the rounding residue could only be released by
            // confiscating unclaimed winnings on a timer.
            winningStakeClaimed += _stakes[staker][winningOutcome];
        }

        _send(staker, amount);
        emit Claimed(staker, amount, refund);
    }

    /**
     * Pay the settlement fee to the treasury. Permissionless, once, after the dispute window.
     *
     * Deliberately not folded into `resolve`: a push transfer inside the one function that must
     * always succeed is a way for a hostile treasury contract to make a market unresolvable. Here
     * a failure is one failed transaction that anybody can retry, and it blocks nothing.
     */
    function settle() external {
        if (status != Status.Resolved) revert NotResolved();
        if (block.timestamp < resolvedAt + disputeWindowSeconds) revert DisputeWindowOpen();
        if (feePaid) revert FeeAlreadyPaid();
        uint256 amount = feeAmount();
        feePaid = true;
        if (amount > 0) _send(treasury, amount);
        emit FeePaid(treasury, amount);
    }

    /**
     * Send the integer-division residue to the treasury, once every winner has been paid.
     *
     * Pro-rata payment by integer division cannot come out even: each winner's share is floored,
     * so the pot retains up to one wei per winner. That residue is real money and it needs a
     * destination, and the two obvious ones are both wrong. Leaving it is a leak that grows by one
     * dust pile per market for ever; releasing it on a timer means confiscating winnings somebody
     * simply had not got round to claiming.
     *
     * So it is released on a CONDITION rather than a clock: `winningStakeClaimed` reaching
     * `pool[winner]` means every winning wei has been claimed by whoever staked it, and whatever
     * is left is arithmetic residue by construction. Unclaimed winnings stay claimable for ever,
     * and this function simply cannot run while any exist.
     */
    function sweepDust() external {
        if (status != Status.Resolved) revert NotResolved();
        if (!feePaid) revert FeeNotPaid();
        if (winningStakeClaimed != pool[winningOutcome]) revert WinnersOutstanding();
        uint256 amount = address(this).balance;
        if (amount == 0) revert NothingToClaim();
        _send(treasury, amount);
        emit DustSwept(treasury, amount);
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}

/**
 * A contract whose entire life is one call, made from its constructor.
 *
 * This exists because of the custody constraint documented on `ForesightMarket._isOracle`: the
 * oracle key may sign a zero-value contract creation and nothing else, so "post the resolution" has
 * to BE a contract creation. The constructor calls `oracleAct` and the contract then deploys with
 * no runtime code at all — it returns nothing, so there is nothing left on chain to call, own or
 * exploit, and the address is burnt with the nonce.
 *
 * `oracleNonce` is the nonce this creation is being signed at, which the market uses to derive this
 * contract's own address and check it against `msg.sender`. A wrong value derives a different
 * address and the market reverts, so the creation simply fails and costs the gas.
 */
contract ForesightResolver {
    constructor(address market, uint8 action, uint64 oracleNonce) {
        IForesightMarket(market).oracleAct(action, oracleNonce);
    }
}
