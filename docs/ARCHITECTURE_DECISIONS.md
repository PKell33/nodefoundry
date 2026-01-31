# Architecture Decision Records

This document captures architectural decisions made during the UI refactor sprint.

## ADR-001: Keep GroupManagement.tsx as Single Component

**Date:** 2026-01-31
**Status:** Accepted
**Context:** GroupManagement.tsx is 319 lines and was evaluated for potential splitting.

### Decision

Keep GroupManagement.tsx as a single component. Do not split.

### Analysis

**Component Structure:**
- 7 state variables (groups, selectedGroup, allUsers, loading, error, showCreateModal, showAddMemberModal)
- 9 handler functions (3 fetch, 3 group CRUD, 3 member management)
- Master-detail UI pattern (groups list + group details)

**Reasons to Keep:**

1. **Cohesive single feature** - Group management is one logical feature, not multiple unrelated features

2. **Master-detail is atomic** - The list and detail panels are conceptually one UI pattern; splitting them adds indirection without benefit

3. **Tightly coupled state** - 7 state variables are interdependent; splitting would require extensive prop drilling:
   - GroupList would need: groups, selectedGroup, loading, error, fetchGroupDetails
   - GroupDetails would need: selectedGroup, allUsers, 6 handlers, 2 modal states

4. **Complexity already delegated** - CreateGroupModal and AddMemberModal are properly extracted

5. **Developer comprehension** - A new developer can understand the entire feature in one file

6. **No duplication** - No repeated code that extraction would reduce

### Alternatives Considered

- **Split into GroupList + GroupDetails**: Would require 10+ props passed between components
- **Extract hooks**: Could extract `useGroupManagement()` if component grows further

### Consequences

- Component remains at 319 lines (acceptable for feature complexity)
- Future growth should consider extracting a custom hook if handlers increase significantly

---

## ADR-002: Do Not Implement Centralized Modal Manager

**Date:** 2026-01-31
**Status:** Accepted
**Context:** Evaluated whether a centralized modal manager (Zustand store + ModalProvider) would benefit the codebase.

### Decision

Do not implement a centralized modal manager. Continue using local state pattern.

### Modal Audit Results

**11 Modal Components:**
- Base: Modal.tsx
- Reusable: AppDetailModal, ConnectionInfoModal, LogViewerModal, EditConfigModal, InstallModal, ConfirmActionModal
- Context-specific: AddAppModal, CreateUserModal, CreateGroupModal, AddMemberModal

**20+ Usage Sites** across ServerCard, Apps, AppDetailModal, MyAccount, Servers, GroupManagement, UserManagement, MountCard, HAConfig, Storage

### Current Pattern

```tsx
const [showModal, setShowModal] = useState(false);
{showModal && <Modal onClose={() => setShowModal(false)} />}
```

### Reasons Against Centralization

1. **No coordination problems exist** - Each component manages its own modals independently. No case where Component A needs to open a modal controlled by Component B.

2. **Stacking already works** - AppDetailModal opens child modals using local state. Hierarchical stacking (parent opens child) doesn't require global state.

3. **Same modal types ≠ shared state** - ConnectionInfoModal is used in multiple places, but each instance has different context (different deploymentId).

4. **Migration cost exceeds benefit** - 11 modals × multiple usage sites would require significant refactoring with no tangible improvement.

5. **Current pattern is well-established** - Codebase consistently uses conditional rendering with local state, documented in Modal.tsx.

### Benefits Analysis

| Centralized Benefit | Needed? |
|---------------------|---------|
| Single place to manage all modals | No - no confusion currently |
| Automatic cleanup on navigation | No - component unmount handles this |
| Modal stacking support | No - already works with local state |
| Easier testing | No - current approach is straightforward |
| Cross-component triggering | No - no use case exists |

### Reconsideration Criteria

Implement centralized modal manager if:
- Cross-component coordination becomes necessary (e.g., global "unsaved changes" modal)
- Modal orchestration is needed (e.g., wizard flows)
- Global modal queue required (e.g., notification stacking)
- Deep component triggering without prop drilling

### Consequences

- Continue with local state pattern for modal management
- Each component remains responsible for its own modal lifecycle
- No additional dependencies or abstractions added
