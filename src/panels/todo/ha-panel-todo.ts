/* eslint-disable no-console */
import { ResizeController } from "@lit-labs/observers/resize-controller";
import "@material/mwc-list";
import {
  mdiChevronDown,
  mdiChevronUp,
  mdiCommentProcessingOutline,
  mdiDelete,
  mdiDotsVertical,
  mdiFilePdfBox,
  mdiInformationOutline,
  mdiPlus,
} from "@mdi/js";
import { endOfDay } from "date-fns";
import type { CSSResultGroup, PropertyValues, TemplateResult } from "lit";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators";
import memoizeOne from "memoize-one";
import { jsPDF } from "jspdf";
import { isComponentLoaded } from "../../common/config/is_component_loaded";
import { storage } from "../../common/decorators/storage";
import { fireEvent } from "../../common/dom/fire_event";
import { computeStateName } from "../../common/entity/compute_state_name";
import { supportsFeature } from "../../common/entity/supports-feature";
import { navigate } from "../../common/navigate";
import { constructUrlCurrentPath } from "../../common/url/construct-url";
import {
  createSearchParam,
  extractSearchParam,
} from "../../common/url/search-params";
import "../../components/ha-button";
import "../../components/ha-fab";
import "../../components/ha-icon-button";
import "../../components/ha-list-item";
import "../../components/ha-menu-button";
import "../../components/ha-state-icon";
import "../../components/ha-svg-icon";
import "../../components/ha-two-pane-top-app-bar-fixed";
import { deleteConfigEntry } from "../../data/config_entries";
import { getExtendedEntityRegistryEntry } from "../../data/entity_registry";
import { fetchIntegrationManifest } from "../../data/integration";
import type { LovelaceCardConfig } from "../../data/lovelace/config/card";
import {
  TodoListEntityFeature,
  getTodoLists,
  fetchItems,
  createItem,
  deleteItems,
  deleteTodoList,
  moveItem,
  TodoItemStatus,
} from "../../data/todo";
import type { TodoItem } from "../../data/todo";
import { showConfigFlowDialog } from "../../dialogs/config-flow/show-dialog-config-flow";
import {
  showAlertDialog,
  showConfirmationDialog,
} from "../../dialogs/generic/show-dialog-box";
import { showVoiceCommandDialog } from "../../dialogs/voice-command-dialog/show-ha-voice-command-dialog";
import { haStyle } from "../../resources/styles";
import type { HomeAssistant } from "../../types";
import "../lovelace/cards/hui-card";
import { showTodoItemEditDialog } from "./show-dialog-todo-item-editor";
import { relativeTime } from "../../common/datetime/relative_time";

@customElement("ha-panel-todo")
class PanelTodo extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property({ type: Boolean, reflect: true }) public narrow = false;

  @property({ type: Boolean, reflect: true }) public mobile = false;

  @storage({
    key: "selectedTodoEntity",
    state: true,
  })
  private _entityId?: string;

  @state() private _expandedLists: Set<string> = new Set();

  @state() private _showAllLists: boolean = false;

  @state() private _allTasks: Record<string, TodoItem[]> = {};

  private _headerHeight = 56;

  private _showPaneController = new ResizeController(this, {
    callback: (entries) => entries[0]?.contentRect.width > 750,
  });

  private _mql?: MediaQueryList;

  private _conversation = memoizeOne((_components) =>
    isComponentLoaded(this.hass, "conversation")
  );

  private async _downloadPdf() {
    const list = getTodoLists(this.hass).find(
      (it) => it.entity_id === this._entityId
    );

    if (list) {
      const doc = new jsPDF();
      let startY = 20;
      doc.setFontSize(12);
      const tasks = await fetchItems(this.hass, list.entity_id);
      doc.text(`${list?.name}`, 10, startY);
      startY += 10;
      let offsetY = startY;
      tasks.forEach((item) => {
        let x = 20;
        if (item.parent) {
          x += 10;
        }
        offsetY += 10;
        doc.roundedRect(x, offsetY - 4, 5, 5, 1, 1);
        if (item.status === TodoItemStatus.Completed) {
          const tickStartX = x + 1; // start point of the tick
          const tickStartY = offsetY - 4 + 5 / 2;

          const tickMiddleX = x + 2; // middle point of the tick
          const tickMiddleY = offsetY - 4 + 5 - 1;

          doc.line(tickStartX, tickStartY, tickMiddleX, tickMiddleY);

          const tickEndX = x + 5 - 1; // end point of the tick
          const tickEndY = offsetY - 4 + 1;

          doc.line(tickMiddleX, tickMiddleY, tickEndX, tickEndY);
        }
        doc.text(`${item.summary}`, x + 10, offsetY);
        if (item.due) {
          const due = item.due
            ? item.due.includes("T")
              ? new Date(item.due)
              : endOfDay(new Date(`${item.due}T00:00:00`))
            : undefined;
          if (due) {
            const originFontSize = doc.getFontSize();
            doc.setFontSize(8);
            const relTime = relativeTime(due, this.hass.locale);
            offsetY += 8;
            doc.text(`Due ${relTime}`, x + 10, offsetY);
            doc.setFontSize(originFontSize);
          }
        }
        if (item.description) {
          const originFontSize = doc.getFontSize();
          doc.setFontSize(8);
          doc.setTextColor("#808080");
          offsetY += 8;
          doc.text(`${item.description}`, x + 10, offsetY);
          doc.setTextColor("#000000");
          doc.setFontSize(originFontSize);
        }
      });
      doc.save(`${list?.name}.pdf`);
    }
  }

  public connectedCallback() {
    super.connectedCallback();
    this._mql = window.matchMedia(
      "(max-width: 450px), all and (max-height: 500px)"
    );
    this._mql.addListener(this._setIsMobile);
    this.mobile = this._mql.matches;
    const computedStyles = getComputedStyle(this);
    this._headerHeight = Number(
      computedStyles.getPropertyValue("--header-height").replace("px", "")
    );
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    this._mql?.removeListener(this._setIsMobile!);
    this._mql = undefined;
  }

  private _setIsMobile = (ev: MediaQueryListEvent) => {
    this.mobile = ev.matches;
  };

  protected willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);

    if (!this.hasUpdated) {
      this.hass.loadFragmentTranslation("lovelace");

      const urlEntityId = extractSearchParam("entity_id");
      if (urlEntityId) {
        this._entityId = urlEntityId;
      } else {
        if (this._entityId && !(this._entityId in this.hass.states)) {
          this._entityId = undefined;
        }
        if (!this._entityId) {
          this._entityId = getTodoLists(this.hass)[0]?.entity_id;
        }
      }
    }

    if (changedProperties.has("_entityId") || !this.hasUpdated) {
      this._setupTodoElement();
    }
  }

  private _setupTodoElement(): void {
    if (!this._entityId) {
      navigate(constructUrlCurrentPath(""), { replace: true });
      return;
    }
    navigate(
      constructUrlCurrentPath(createSearchParam({ entity_id: this._entityId })),
      { replace: true }
    );
  }

  private _cardConfig = memoizeOne(
    (entityId: string) =>
      ({
        type: "todo-list",
        entity: entityId,
      }) as LovelaceCardConfig
  );

  // Asynchronous method that gets all tasks from all todo lists
  private async _fetchAllTasks() {
    // Get all todo lists
    const todoLists = getTodoLists(this.hass);

    // Gets all tasks from all lists
    // Map all lists to their corresponding entity_id and associated tasks
    const allTasks = await Promise.all(
      todoLists.map(async (list) => ({
        entity_id: list.entity_id, // ID of the current todo list
        tasks: await fetchItems(this.hass, list.entity_id),
      }))
    );

    // Converts the array of tasks into records, where the 'entity_id's are the keys
    this._allTasks = allTasks.reduce(
      (acc, { entity_id, tasks }) => {
        acc[entity_id] = tasks;
        return acc;
      },
      {} as Record<string, TodoItem[]>
    );
  }

  // Toggles whether all lists are shown or not
  private _toggleShowAllLists() {
    this._showAllLists = !this._showAllLists;
    if (this._showAllLists) {
      this._fetchAllTasks(); // Fetches all tasks if all lists are shown
    }
  }

  protected render(): TemplateResult {
    const entityRegistryEntry = this._entityId
      ? this.hass.entities[this._entityId]
      : undefined;
    const entityState = this._entityId
      ? this.hass.states[this._entityId]
      : undefined;
    const showPane = this._showPaneController.value ?? !this.narrow;
    const listItems = getTodoLists(this.hass).map(
      (list) => html`
        <ha-list-item
          graphic="icon"
          @click=${this._handleEntityPicked}
          .entityId=${list.entity_id}
          .activated=${list.entity_id === this._entityId}
        >
          <ha-state-icon
            .stateObj=${list}
            .hass=${this.hass}
            slot="graphic"
          ></ha-state-icon>
          ${list.name}
          <ha-icon-button
            slot="trailingIcon"
            .path=${this._expandedLists.has(list.entity_id)
              ? mdiChevronUp
              : mdiChevronDown}
            @click=${this._handleToggleList}
            .entityId=${list.entity_id}
          ></ha-icon-button>
        </ha-list-item>
        ${this._expandedLists.has(list.entity_id)
          ? html`
              <div class="tasks">
                <!-- Render tasks for the list here -->
              </div>
            `
          : nothing}
      `
    );
    return html`
      <ha-two-pane-top-app-bar-fixed .pane=${showPane} footer>
        <ha-button slot="actionItems" @click=${this._toggleShowAllLists}>
          <span style="color: white"
            >${this._showAllLists ? "Hide All Lists" : "Show All Lists"}</span
          >
        </ha-button>
        <ha-menu-button
          slot="navigationIcon"
          .hass=${this.hass}
          .narrow=${this.narrow}
        ></ha-menu-button>
        <div slot="title">
          ${!showPane
            ? html`
                <ha-button-menu
                  class="lists"
                  activatable
                  fixed
                  .noAnchor=${this.mobile}
                  .y=${this.mobile
                    ? this._headerHeight / 2
                    : this._headerHeight / 4}
                  .x=${this.mobile ? 0 : undefined}
                >
                  <ha-button slot="trigger">
                    <div>
                      ${this._entityId
                        ? entityState
                          ? computeStateName(entityState)
                          : this._entityId
                        : ""}
                    </div>
                    <ha-svg-icon
                      slot="trailingIcon"
                      .path=${mdiChevronDown}
                    ></ha-svg-icon>
                  </ha-button>
                  ${listItems}
                  ${this.hass.user?.is_admin
                    ? html`
                        <li divider role="separator"></li>
                        <ha-list-item graphic="icon" @click=${this._addList}>
                          <ha-svg-icon
                            .path=${mdiPlus}
                            slot="graphic"
                          ></ha-svg-icon>
                          ${this.hass.localize("ui.panel.todo.create_list")}
                        </ha-list-item>
                      `
                    : nothing}
                </ha-button-menu>
              `
            : this.hass.localize("panel.todo")}
        </div>
        <mwc-list slot="pane" activatable>${listItems}</mwc-list>
        ${showPane && this.hass.user?.is_admin
          ? html`
              <ha-list-item
                graphic="icon"
                slot="pane-footer"
                @click=${this._addList}
              >
                <ha-svg-icon .path=${mdiPlus} slot="graphic"></ha-svg-icon>
                ${this.hass.localize("ui.panel.todo.create_list")}
              </ha-list-item>
            `
          : nothing}
        <ha-button-menu slot="actionItems">
          <ha-icon-button
            slot="trigger"
            .label=${""}
            .path=${mdiDotsVertical}
          ></ha-icon-button>
          ${this._conversation(this.hass.config.components)
            ? html`
                <ha-list-item
                  graphic="icon"
                  @click=${this._showMoreInfoDialog}
                  .disabled=${!this._entityId}
                >
                  <ha-svg-icon .path=${mdiInformationOutline} slot="graphic">
                  </ha-svg-icon>
                  ${this.hass.localize("ui.panel.todo.information")}
                </ha-list-item>
              `
            : nothing}
          <li divider role="separator"></li>
          <ha-list-item graphic="icon" @click=${this._showVoiceCommandDialog}>
            <ha-svg-icon
              .path=${mdiCommentProcessingOutline}
              slot="graphic"
            ></ha-svg-icon>
            ${this.hass.localize("ui.panel.todo.assist")}
          </ha-list-item>

          ${entityRegistryEntry?.platform === "local_todo" ||
          entityRegistryEntry?.platform === "google_tasks"
            ? html`
                <li divider role="separator"></li>
                <ha-list-item
                  graphic="icon"
                  @click=${this._deleteList}
                  class="warning"
                  .disabled=${!this._entityId}
                >
                  <ha-svg-icon
                    .path=${mdiDelete}
                    slot="graphic"
                    class="warning"
                  >
                  </ha-svg-icon>
                  ${this.hass.localize("ui.panel.todo.delete_list")}
                </ha-list-item>
              `
            : nothing}
          <li divider role="separator"></li>
          <ha-list-item graphic="icon" @click=${this._downloadPdf}>
            <ha-svg-icon .path=${mdiFilePdfBox} slot="graphic"></ha-svg-icon>
            ${this.hass.localize("ui.panel.todo.export_pdf")}
          </ha-list-item>
        </ha-button-menu>
        ${!this._showAllLists
          ? html`
              <div id="columns">
                <div class="column">
                  ${this._entityId
                    ? html`
                        <hui-card
                          .hass=${this.hass}
                          .config=${this._cardConfig(this._entityId)}
                        ></hui-card>
                      `
                    : nothing}
                </div>
              </div>
            `
          : nothing}
        ${entityState &&
        supportsFeature(entityState, TodoListEntityFeature.CREATE_TODO_ITEM)
          ? html`
              <ha-fab
                .label=${this.hass.localize("ui.panel.todo.add_item")}
                extended
                @click=${this._addItem}
              >
                <ha-svg-icon slot="icon" .path=${mdiPlus}></ha-svg-icon>
              </ha-fab>
            `
          : nothing}
        ${this._showAllLists
          ? html`
              <div id="columns">
                <div class="column all-lists-display">
                  ${getTodoLists(this.hass).map(
                    (list) => html`
                      <div class="list-name">${list.name}</div>
                      <hui-card
                        .hass=${this.hass}
                        .config=${this._cardConfig(list.entity_id)}
                      ></hui-card>
                    `
                  )}
                </div>
              </div>
            `
          : nothing}
      </ha-two-pane-top-app-bar-fixed>
    `;
  }

  private _handleEntityPicked(ev) {
    this._entityId = ev.currentTarget.entityId;
  }

  private _handleToggleList(ev) {
    ev.stopPropagation();
    const entityId = ev.currentTarget.entityId;
    this._toggleList(entityId);
  }

  private _toggleList(entityId: string) {
    if (this._expandedLists.has(entityId)) {
      this._expandedLists.delete(entityId);
    } else {
      this._expandedLists.add(entityId);
    }
    this.requestUpdate();
  }

  private async _addList(): Promise<void> {
    showConfigFlowDialog(this, {
      startFlowHandler: "local_todo",
      showAdvanced: this.hass.userData?.showAdvanced,
      manifest: await fetchIntegrationManifest(this.hass, "local_todo"),
    });
  }

  private _showMoreInfoDialog(): void {
    if (!this._entityId) {
      return;
    }
    fireEvent(this, "hass-more-info", { entityId: this._entityId });
  }

  private async _deleteList(): Promise<void> {
    if (!this._entityId) {
      return;
    }

    const entityRegistryEntry = await getExtendedEntityRegistryEntry(
      this.hass,
      this._entityId
    );

    if (
      entityRegistryEntry.platform !== "local_todo" &&
      entityRegistryEntry.platform !== "google_tasks"
    ) {
      return;
    }

    const entryId = entityRegistryEntry.config_entry_id;
    if (!entryId) {
      return;
    }

    const confirmed = await showConfirmationDialog(this, {
      title: this.hass.localize("ui.panel.todo.delete_confirm_title", {
        name:
          this._entityId in this.hass.states
            ? computeStateName(this.hass.states[this._entityId])
            : this._entityId,
      }),
      text: this.hass.localize("ui.panel.todo.delete_confirm_text"),
      confirmText: this.hass!.localize("ui.common.delete"),
      dismissText: this.hass!.localize("ui.common.cancel"),
      destructive: true,
    });

    if (!confirmed) {
      return;
    }

    let result;
    if (entityRegistryEntry.platform === "local_todo") {
      result = await deleteConfigEntry(this.hass, entryId);
    } else if (entityRegistryEntry.platform === "google_tasks") {
      try {
        result = await deleteTodoList(this.hass, this._entityId);
      } catch (err) {
        showAlertDialog(this, {
          text: "Cannot delete default Google Tasks list",
        });
        return;
      }
    }

    this._entityId = getTodoLists(this.hass)[0]?.entity_id;

    if (result.require_restart) {
      showAlertDialog(this, {
        text: this.hass.localize("ui.panel.todo.restart_confirm"),
      });
    }
  }

  private _showVoiceCommandDialog(): void {
    showVoiceCommandDialog(this, this.hass, { pipeline_id: "last_used" });
  }

  private _addItem() {
    showTodoItemEditDialog(this, { entity: this._entityId! });
  }

  /* drag and drop functions */
  // Add an item (and its children) to a target list
  public async _addItemToTargetList(
    uid: string,
    targetListId: string
  ): Promise<string | null> {
    // Find the item to add
    const item = this._findItemByUid(uid);

    // Check if the item exists
    if (item) {
      try {
        // Get the list of items before adding the new item
        const targetListBefore = this._allTasks[targetListId] || [];

        // Recursive helper function to add item and its children
        const addItemAndChildren = async (
          currentItem: TodoItem,
          currentParentUid: string | null
        ): Promise<string | null> => {
          // Add the current item to the target list
          await createItem(this.hass, targetListId, {
            summary: currentItem.summary,
            description: currentItem.description || undefined,
            due: currentItem.due || undefined,
            parent: currentParentUid || undefined, // Link to the parent in the new list
          });

          // Fetch updated tasks to get the newly added item's UID
          await this._fetchAllTasks();

          const targetListAfter = this._allTasks[targetListId] || [];
          const newItem = targetListAfter.find(
            (newTask) =>
              !targetListBefore.some(
                (oldItem) => oldItem.uid === newTask.uid
              ) && newTask.summary === currentItem.summary
          );

          if (!newItem) {
            console.error(
              "Failed to locate the newly added item in the target list:",
              currentItem
            );
            return null;
          }

          // Process children concurrently
          const children = this._getChildrenFromAllTasks(currentItem.uid);
          const childAdditions = children.map((child) =>
            addItemAndChildren(child, newItem.uid)
          );

          await Promise.all(childAdditions); // Wait for all children to be added

          return newItem.uid; // Return the UID of the newly added item
        };

        // Start by adding the root item
        return await addItemAndChildren(item, null);
      } catch (error) {
        console.error("Error adding item to target list:", error);
        return null;
      }
    } else {
      console.error("Item not found:", uid);
      return null;
    }
  }

  private _getChildrenFromAllTasks(parentUid: string): TodoItem[] {
    const children: TodoItem[] = [];
    for (const listId in this._allTasks) {
      if (Object.prototype.hasOwnProperty.call(this._allTasks, listId)) {
        const list = this._allTasks[listId];
        children.push(...list.filter((item) => item.parent === parentUid));
      }
    }
    return children;
  }

  // Find an item by its UID
  private _findItemByUid(uid: string): TodoItem | undefined {
    // Loop through all lists
    for (const listId in this._allTasks) {
      // Check if the list has the item
      if (Object.prototype.hasOwnProperty.call(this._allTasks, listId)) {
        // Find the item in the list and return it
        const list = this._allTasks[listId];
        const item = list.find((task) => task.uid === uid);
        if (item) {
          return item;
        }
      }
    }
    return undefined;
  }

  // Delete an item from the list
  public async _deleteItemFromList(uid: string, listId: string) {
    // Find the item to delete
    const list = this._allTasks[listId];
    const item = list?.find((task) => task.uid === uid);

    // Check if the item exists
    if (item) {
      // Delete the item
      try {
        await deleteItems(this.hass, listId, [item.uid]);
        // Fetch the updated tasks
        await this._fetchAllTasks();
      } catch (error) {
        console.error("Error deleting item from list:", error);
      }
    } else {
      console.error("Item not found in list:", uid, listId);
    }
  }

  // Move an item in the list
  public async moveItemInOrder(
    uid: string,
    targetListId: string,
    previousUid: string | undefined
  ): Promise<void> {
    // Move the item in the list
    try {
      await moveItem(this.hass, targetListId, uid, previousUid);
      // Fetch the updated tasks
      await this._fetchAllTasks();
    } catch (error) {
      console.error("Error moving item in order:", error);
    }
  }

  static get styles(): CSSResultGroup {
    return [
      haStyle,
      css`
        :host {
          display: block;
        }
        #columns {
          display: flex;
          flex-direction: row;
          justify-content: center;
          margin: 8px;
          padding-bottom: 70px;
        }
        .column {
          flex: 1 0 0;
          max-width: 500px;
          min-width: 0;
        }
        :host([mobile]) .lists {
          --mdc-menu-min-width: 100vw;
        }
        :host(:not([mobile])) .lists ha-list-item {
          max-width: calc(100vw - 120px);
        }
        :host([mobile]) ha-button-menu {
          --mdc-shape-medium: 0 0 var(--mdc-shape-medium)
            var(--mdc-shape-medium);
        }
        ha-button-menu {
          max-width: 100%;
        }
        ha-button-menu ha-button {
          --button-slot-container-overflow: hidden;
          max-width: 100%;
          --mdc-theme-primary: currentColor;
          --mdc-typography-button-text-transform: none;
          --mdc-typography-button-font-size: var(
            --mdc-typography-headline6-font-size,
            1.25rem
          );
          --mdc-typography-button-font-weight: var(
            --mdc-typography-headline6-font-weight,
            500
          );
          --mdc-typography-button-letter-spacing: var(
            --mdc-typography-headline6-letter-spacing,
            0.0125em
          );
          --mdc-typography-button-line-height: var(
            --mdc-typography-headline6-line-height,
            2rem
          );
          --button-height: 40px;
        }
        ha-button-menu ha-button div {
          text-overflow: ellipsis;
          width: 100%;
          overflow: hidden;
          white-space: nowrap;
          display: block;
        }
        ha-fab {
          position: fixed;
          right: 16px;
          bottom: 16px;
          inset-inline-end: 16px;
          inset-inline-start: initial;
        }
        .tasks {
          padding-left: 16px;
          padding-right: 16px;
        }
        .task {
          padding: 8px;
          border-bottom: 1px solid var(--divider-color);
        }
        .all-lists-display {
          display: grid;
          gap: 8px;
        }
        .list-name {
          color: var(--primary-text-color);
          font-size: 20px;
          font-weight: 400;
          padding-bottom: 4px;
          padding-top: 4px;
        }
      `,
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-panel-todo": PanelTodo;
  }
}
