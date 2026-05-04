# Veeam Knowledge Base

## 0. Behavior Classification Framework (Simulator Contract)

Use this classification when implementing or reviewing changes.

### 0.1 Global Behaviors
- Apply to all repositories and policies unless explicitly disabled.
- Must be protected by invariant checks and regression tests.
- Current global contract:
	- Exactly one base full per job at any point in time.
	- Base identity is the oldest Full/SyntheticFull across all chains in the job storage set.
	- Retention SLA is a minimum guarantee (count expiry cannot override SLA).
	- Base SyntheticFull is full-sized; non-base SyntheticFull is incremental-sized.
	- Planned capacity includes working space sized as a percentage of the largest full backup for the forecast year; projected used values exclude working space.

### 0.2 Feature-Specific Behaviors
- Apply only when the corresponding feature is enabled/selected.
- Must not violate global behaviors.
- Typical feature-specific modules:
	- Job type semantics (Forward Incremental, Reverse Incremental, Active Full, Synthetic Full).
	- GFS overlays (weekly/monthly/yearly tagging and retention caps).
	- SOBR tiering semantics (Copy, Move, Archive transitions).
	- Repository capability differences (DAS/NAS/Dedupe/Object/Tape optimizations).

---

### 5.5 Retention SLA and Chain Status
- **Definition:**
	- Retention SLA (Service Level Agreement) specifies the minimum period that restore points must be retained and available for recovery.
- **Active Chains:**
	- All restore points in an active chain are retained, regardless of age, until the chain becomes inactive (i.e., a new full backup starts a new chain).
	- Retention SLA is enforced by preventing deletion of any restore point in the active chain.
- **Inactive Chains:**
	- Once a chain is inactive, retention SLA is enforced by deleting the chain only when all restore points within it are older than the retention window and not required by GFS or other policies.
	- If any restore point in the chain is within the retention SLA, the entire chain (and its blocks/objects) is retained.
- **GFS and Extended Retention:**
	- GFS-tagged fulls are retained according to their own (often longer) SLA, independent of standard retention.
	- Blocks/objects referenced by GFS restore points are preserved until their GFS retention expires, even if the rest of the chain is deleted.
- **Simulation Implications:**
	- The simulator must enforce retention SLA at the chain level, ensuring no restore point is deleted prematurely.
	- SLA is a global minimum guarantee and must not be bypassed by count-only expiry logic.
	- GFS and standard retention must be tracked independently, with correct block/object preservation.
### 5.4 Active and Inactive Backup Chains
- **Definition:**
	- An **active backup chain** is the current chain being appended to by new incremental backups. It starts with a full (VBK) and includes all subsequent incrementals (VIBs) until a new full is created.
	- An **inactive backup chain** is a closed chain that is no longer being appended to. This occurs when a new full backup starts a new chain, or when a chain is offloaded/moved to object storage and is no longer updated.
- **Impact on Retention and GFS:**
	- Retention policies are applied at the chain level. Only inactive chains are eligible for deletion when all their restore points age out, unless GFS tagging preserves a full.
	- GFS fulls are typically created from inactive chains, and their referenced blocks are preserved per GFS policy.
- **Synthetic Fulls and Chain Promotion:**
	- When a synthetic full is created, it may close the previous chain (making it inactive) and start a new active chain.
	- If a restore point in an inactive chain matches a GFS schedule, it is promoted to a GFS full and retained.
- **SOBR Offload/Move:**
	- Only inactive chains are eligible for move to SOBR Capacity Tier (object storage) in Move mode.
	- Active chains remain on the Performance Tier until closed.
- **Block/Object Retention:**
	- Blocks/objects belonging to inactive chains are deleted only when all restore points in the chain are outside retention and not required by GFS.
	- Active chain blocks are always retained until the chain becomes inactive.
- **Simulation Implications:**
	- The simulator must track chain status (active/inactive) for each backup chain.
	- Retention, GFS, and offload logic must operate on chains according to their status.
	- Chain status logic is global; offload behavior on top of it is feature-specific (SOBR only).
	- Only inactive chains should be considered for deletion or offload/move operations.
### 5.3 Veeam Object Storage Block Generation Model
- **Description:**
	- When backups are offloaded or written directly to object storage, Veeam splits backup files into multiple immutable blocks (objects), typically 1GB each by default.
	- Each backup chain (full and incrementals) is represented as a set of objects, with metadata tracking block relationships and restore points.
- **Block Reuse and Chain Management:**
	- Incremental backups reference unchanged blocks from previous backups, minimizing storage usage (similar to block cloning on ReFS/XFS, but at the object level).
	- Synthetic fulls in object storage are created by referencing existing blocks, not duplicating data, resulting in efficient storage and fast operations.
	- GFS fulls are promoted by referencing the required blocks, ensuring long-term retention with minimal additional storage.
- **Retention and Deletion:**
	- When retention policies remove old restore points, only unreferenced blocks are deleted from object storage.
	- GFS tagging ensures that blocks required for long-term restore points are preserved, even if the original chain is deleted.
- **Copy/Move Modes Impact:**
	- In Copy mode, all blocks for each backup are uploaded to object storage immediately.
	- In Move mode, blocks are uploaded when backups age out of the operational window; local files are deleted after successful offload.
- **Simulation Implications:**
	- The simulator must model backup chains as collections of blocks/objects, with reference tracking for each restore point.
	- Synthetic fulls and GFS points should not duplicate blocks, but reference existing ones.
	- Retention logic must ensure only unreferenced blocks are deleted, accurately reflecting storage usage over time.
	- The model must support both direct-to-object and offload scenarios, with correct handling of Copy/Move modes and GFS retention.
---

## 5. Advanced Storage Technologies and Retention Behaviors

### 5.1 ReFS/XFS Link Clone (Block Clone) Technology
- **Description:**
	- Microsoft ReFS (Windows) and Linux XFS (with reflink) enable Veeam to use block cloning (Link Clone/Fast Clone) for backup files.
	- This allows synthetic full backups and GFS retention to be created as virtual copies, referencing unchanged data blocks instead of duplicating them, saving significant storage space and speeding up operations.
- **Supported Job Types:**
	- Forward Incremental (with synthetic fulls)
	- GFS (Grandfather-Father-Son) retention
	- Backup Copy jobs (with GFS)
- **How It Works:**
	- When a synthetic full is created, only changed blocks are written; unchanged blocks are referenced from previous files.
	- GFS fulls are created as virtual copies (block clones) of the latest full, with minimal additional storage.
	- When retention is applied, if a GFS point needs to be preserved, the corresponding full is promoted to a GFS full (block clone), ensuring it is not deleted.
- **Base Full Backups & Promotion:**
	- The simulator's global base identity is the oldest Full/SyntheticFull across all chains in the job storage set.
	- When retention removes older restore points, a synthetic full may be promoted to a GFS full if it matches a GFS schedule.
	- Block cloning ensures minimal space is used for these promotions.
- **Benefits:**
	- Dramatic storage savings for long chains and GFS policies.
	- Faster synthetic full and GFS operations.
	- Reduced I/O and backup window.
- **Requirements:**
	- ReFS (Windows) or XFS with reflink (Linux) formatted repository.
	- Supported by Veeam Backup & Replication v9.5u3+ (ReFS) and v10+ (XFS).

### 5.2 SOBR Capacity Tier: Copy and Move Modes, Object Storage File Changes
- **Copy Mode:**
	- All backups are copied to the Capacity Tier (object storage) as soon as they are created, providing an immediate offsite copy.
	- No impact on local retention; object storage acts as a secondary location.
- **Move Mode:**
	- Backups are moved to the Capacity Tier after they age out of the operational restore window (local retention period).
	- Local files are deleted after successful offload, freeing up space.
- **Backup File Changes for Object Storage:**
	- When backups are offloaded, Veeam consolidates backup chains into optimized objects (blocks) in object storage.
	- Metadata is maintained to allow restore operations directly from object storage.
	- GFS points are preserved in object storage according to retention policy.
- **Retention Behavior:**
	- Local retention applies to Performance Tier (on-prem storage).
	- Capacity Tier retention is managed independently; GFS points and offloaded backups are retained per policy.
	- When a backup chain is removed from local storage, GFS tagging ensures required fulls are retained in object storage.
- **Best Practices:**
	- Use Copy mode for immediate offsite protection.
	- Use Move mode to optimize local storage usage.
	- Monitor object storage costs and retention settings.
	- Ensure GFS policies align with business requirements for long-term retention.

## 1. Veeam Repository Types

### 1.1 Direct Attached Storage (DAS)
- Local disks attached to the backup server or proxy (e.g., internal HDDs, USB drives).
- Fast access, limited scalability, low cost.
- Use Cases: Small environments, test labs, short-term retention.

### 1.2 Network Attached Storage (NAS)
- Network shares (SMB/CIFS, NFS).
- Shared access, moderate performance, easy expansion.
- Use Cases: Medium environments, file-level backups, shared storage.

### 1.3 Deduplication Appliances
- Purpose-built storage with deduplication (e.g., HPE StoreOnce, Dell EMC Data Domain).
- High deduplication, optimized for sequential writes, may require integration (DDBoost, Catalyst).
- Use Cases: Large environments, long-term retention, WAN replication.

### 1.4 Object Storage
- S3-compatible storage (AWS S3, Azure Blob, Wasabi, etc.).
- Highly scalable, offsite, supports immutability (object lock), and can be used as:
	- **Direct backup target** for supported workloads (e.g., Veeam Backup for Microsoft 365, Veeam Agent for Linux/Windows, and some VBR workloads in v12+).
	- **SOBR extent** for Performance, Capacity, and Archive Tiers.
- Use Cases: Direct-to-object backups, offsite retention, ransomware protection, long-term archival, scale-out backup repository (SOBR) extension.
- **Best Practices:**
	- Enable immutability for ransomware protection.
	- Monitor API request costs and egress charges.
	- Use lifecycle policies for cost management.
	- Consider bandwidth and latency for direct backup/restore operations.

### 1.5 Tape
- Physical tape libraries or drives.
- Offline, air-gapped, slow access, long-term archival.
- Use Cases: Compliance, long-term retention, disaster recovery.

### 1.6 Scale-Out Backup Repository (SOBR)
- Logical pool of multiple repositories, supporting multiple tiers:
	- **Performance Tier:** Typically local or fast storage (DAS, NAS, dedupe appliances, or object storage in v12+).
	- **Capacity Tier:** Object storage (S3, Azure Blob, etc.) for offloading older backups.
	- **Archive Tier:** Object storage (e.g., Amazon S3 Glacier, Azure Archive Blob) for long-term retention.
- Object Storage can be used as an extent in any tier (Performance, Capacity, Archive) depending on Veeam version and workload.
- Automated tiering, scalability, combines multiple storage types.
- Use Cases: Large, growing environments, tiered storage strategies, cost optimization, compliance.
- **Best Practices:**
	- Use object storage with immutability for Capacity/Archive Tiers.
	- Monitor tiering policies and offload schedules.
	- Ensure all extents meet performance and compatibility requirements for their tier.

---

## 2. Veeam Backup Job Types

### 2.1 Forward Incremental
- Initial full backup (VBK), followed by incrementals (VIB).
- Synthetic or active fulls can be scheduled.
- Each VIB depends on previous VIBs and the VBK.
- Oldest restore points deleted as per policy; may trigger merge of oldest VIBs into VBK.

### 2.2 Reverse Incremental
- Initial full backup (VBK), each backup updates VBK to latest state, creates VRB (reverse incremental) for previous state.
- Each VRB allows rollback to previous states.
- Oldest VRBs deleted as per policy.

### 2.3 Synthetic Full
- Creates a new full backup (VBK) by merging existing full and incrementals, without reading source data.
- New VBK synthesized from previous VBK + VIBs.
- Breaks dependency chain, allows for new incremental chain.
- Old chain can be deleted after new full is created.

### 2.4 Active Full
- Reads all source data to create a new full backup (VBK).
- Starts a new chain.
- Old chain can be deleted after new full is created.

### 2.5 GFS (Grandfather-Father-Son)
- Retention policy for weekly, monthly, yearly fulls.
- Marks certain fulls as weekly/monthly/yearly.
- GFS restore points are retained per schedule, not deleted with regular retention.
- GFS points kept as per policy, others deleted.

---

## 3. File Types and Lifecycle

| File Type | Description                | Created By                | Lifecycle/Retention         |
|-----------|----------------------------|---------------------------|-----------------------------|
| VBK       | Full backup                | All job types             | Retained per policy         |
| VIB       | Forward incremental        | Forward Incremental jobs  | Merged/deleted as needed    |
| VRB       | Reverse incremental        | Reverse Incremental jobs  | Deleted as needed           |
| VBM       | Metadata file              | All jobs                  | Updated with each backup    |
| VLB       | Log backup                 | SQL/Oracle log jobs       | Retained per policy         |
| .map      | Block map (dedupe)         | Deduplication appliances  | Internal use                |

---

## 4. Job Type and Repository Type Interactions

| Job Type             | DAS/NAS         | Dedup Appliance         | Object Storage         | Tape                | SOBR                |
|----------------------|-----------------|------------------------|-----------------------|---------------------|---------------------|
| Forward Incremental  | Supported       | Supported (optimized)  | Supported*            | Copy/Archive only   | Supported           |
| Reverse Incremental  | Supported       | Not recommended        | Not supported         | Not supported       | Supported           |
| Synthetic Full       | Supported       | Supported (optimized)  | Supported*            | Not supported       | Supported           |
| Active Full          | Supported       | Supported              | Supported*            | Not supported       | Supported           |
| GFS                  | Supported       | Supported              | Supported*            | Supported           | Supported           |

*Object Storage: Supported as a direct backup target for specific workloads (e.g., Veeam Backup for Microsoft 365, Veeam Agent, and VBR v12+ for some jobs). Always supported as SOBR extent (Performance, Capacity, Archive Tiers) for offload and long-term retention.

- Deduplication Appliances: Prefer forward incremental with synthetic fulls; reverse incremental is not recommended due to random I/O.
- Object Storage: Can be used as a direct backup target for supported workloads and as an extent for all SOBR tiers. For most VBR jobs, object storage is used for offload (Capacity/Archive), but direct-to-object is increasingly supported (check Veeam version and job type).
- Tape: Used for backup copy/archive, not for primary backup chains.

---

## 6. Simulator UI Behaviour Contract

### 6.1 Top Row Layout
- Two equal-width cards fill the full page width side by side (`flex: 1 1 0`).
- Left card: Repository Storage Usage table (stretches to card height via flex column).
- Right card: Summary stat tiles (Total RPs, Total Storage, Active Chains, GFS Points) + Policy Insight card below.

### 6.2 Policy Insight Severity Model
Policy Insight is state-driven (never inferred from activity log text). Three severity levels:

| Severity | Badge shape | Color | Trigger |
|---|---|---|---|
| `ok` | Circle ✓ | Green | No actionable issues |
| `warning` | Triangle ! | Amber | Actionable recommendations exist (not blocking) |
| `danger` | Octagon ! | Red | Retention ≤ offload threshold, or inactive chains overdue in Performance |

**Recommendations** (amber/red, bulleted list):
- Retention too short for offload threshold → danger
- Inactive chains past threshold still in Performance → danger
- Archive tier enabled but no GFS policy → warning
- GFS configured but Archive tier disabled → warning
- Retention ≤ offload threshold (ForwardIncremental/SyntheticFull) → warning

**Info notes** (italic grey, never trigger warning severity):
- "Oldest inactive chain is Xd; offload starts at Yd" — informational only
- "No GFS policy configured" — shown only when Archive tier is NOT enabled (if Archive is enabled, this escalates to a recommendation instead)

### 6.3 Activity Log
- Events grouped by simulation date, collapsible, newest-to-oldest.
- Current day expanded by default; summary count shown per day (e.g., "2 Backup, 1 Move").
- Each event categorised and color-coded:
  - **Copy** — point copied to Capacity (Copy mode)
  - **Move** — Performance → Capacity offload finalized
  - **Tier Move** — Capacity → Archive
  - **GFS Tag** — point tagged as weekly/monthly/yearly GFS
  - **GFS Expiry** — GFS tag expired, point deleted
  - **Promotion** — base full promoted/set
  - **Backup** — new restore point created
  - **Retention** — chain or point deleted by retention
  - **Info** — informational engine events
- Multi-day jumps (+7/+30) preserve per-day event attribution via `[YYYY-MM-DD]` prefixes in the activity string.
