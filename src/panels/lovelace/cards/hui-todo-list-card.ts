/* eslint-disable no-console */
/* eslint-disable lit/no-template-arrow */
import "@material/mwc-list/mwc-list";
import type { List } from "@material/mwc-list/mwc-list";
import {
  mdiClock,
  mdiDelete,
  mdiDeleteSweep,
  mdiDotsVertical,
  mdiDrag,
  mdiPlus,
  mdiSort,
  mdiSortAlphabeticalAscending,
  mdiSortAlphabeticalDescending,
  mdiSubdirectoryArrowRight,
  mdiSortCalendarAscending,
  mdiSortCalendarDescending,
} from "@mdi/js";
import { endOfDay, isSameDay } from "date-fns";
import type { UnsubscribeFunc } from "home-assistant-js-websocket";
import type { CSSResultGroup, PropertyValueMap, PropertyValues } from "lit";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators";
import { classMap } from "lit/directives/class-map";
import { repeat } from "lit/directives/repeat";
import memoizeOne from "memoize-one";
import { applyThemesOnElement } from "../../../common/dom/apply_themes_on_element";
import { supportsFeature } from "../../../common/entity/supports-feature";
import { stopPropagation } from "../../../common/dom/stop_propagation";
import "../../../components/ha-card";
import "../../../components/ha-check-list-item";
import "../../../components/ha-checkbox";
import "../../../components/ha-icon-button";
import "../../../components/ha-list-item";
import "../../../components/ha-markdown-element";
import "../../../components/ha-relative-time";
import "../../../components/ha-select";
import "../../../components/ha-sortable";
import "../../../components/ha-svg-icon";
import "../../../components/ha-textfield";
import type { HaTextField } from "../../../components/ha-textfield";
import { isUnavailableState } from "../../../data/entity";
import type { TodoItem } from "../../../data/todo";
import {
  TodoItemStatus,
  TodoListEntityFeature,
  createItem,
  deleteItems,
  moveItem,
  subscribeItems,
  updateItem,
} from "../../../data/todo";
import { showConfirmationDialog } from "../../../dialogs/generic/show-dialog-box";
import type { HomeAssistant } from "../../../types";
import { showTodoItemEditDialog } from "../../todo/show-dialog-todo-item-editor";
import { findEntities } from "../common/find-entities";
import { createEntityNotFoundWarning } from "../components/hui-warning";
import type { LovelaceCard, LovelaceCardEditor } from "../types";
import type { TodoListCardConfig } from "./types";

let _draggedItem: TodoItem | null = null;
let _fromList: string | undefined;
type sortDirection = "asc" | "desc";
type SortKey = Extract<keyof TodoItem, "summary" | "due">;

interface ParentItem {
  item: TodoItem;
  children: TodoItem[];
}

@customElement("hui-todo-list-card")
export class HuiTodoListCard extends LitElement implements LovelaceCard {
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    await import("../editor/config-elements/hui-todo-list-editor");
    return document.createElement("hui-todo-list-card-editor");
  }

  public static getStubConfig(
    hass: HomeAssistant,
    entities: string[],
    entitiesFallback: string[]
  ): TodoListCardConfig {
    const includeDomains = ["todo"];
    const maxEntities = 1;
    const foundEntities = findEntities(
      hass,
      maxEntities,
      entities,
      entitiesFallback,
      includeDomains
    );

    return { type: "todo-list", entity: foundEntities[0] || "" };
  }

  @property({ attribute: false }) public hass?: HomeAssistant;

  /**
   * The sorting direction when `_sortKey` is non-null this property can be 'asc' or 'desc'.
   */
  @state() private _sortDirection: sortDirection = "asc";

  /**
   * Determines which field of the todo-items are used for sorting.
   */
  @state() private _sortKey?: SortKey;

  @state() private _config?: TodoListCardConfig;

  @state() private _entityId?: string;

  @state() private todoInput?: string;

  @state() private _items?: TodoItem[];

  @state() private _reordering = false;

  // @state() private _showDropZone = false;

  private _unsubItems?: Promise<UnsubscribeFunc>;

  /* Drag and drop functionality event listeners */
  private _addEventListeners() {
    const dropTargets = this.shadowRoot?.querySelectorAll(".todo-item");
    dropTargets?.forEach((target) => {
      target.addEventListener(
        "dragover",
        this._handleDragOver.bind(this) as EventListener
      );
      target.addEventListener(
        "dragleave",
        this._handleDragLeave.bind(this) as EventListener
      );
      target.addEventListener(
        "drop",
        this._handleDrop.bind(this) as unknown as EventListener
      );
    });
  }

  private _removeEventListeners() {
    const dropTargets = this.shadowRoot?.querySelectorAll(".todo-item");
    dropTargets?.forEach((target) => {
      target.removeEventListener(
        "dragover",
        this._handleDragOver.bind(this) as EventListener
      );
      target.removeEventListener(
        "dragleave",
        this._handleDragLeave.bind(this) as EventListener
      );
      target.removeEventListener(
        "drop",
        this._handleDrop as unknown as EventListener
      );
    });
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) {
      this._subscribeItems();
    }
    this._addEventListeners();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubItems?.then((unsub) => unsub());
    this._unsubItems = undefined;
    this._removeEventListeners();
  }

  public getCardSize(): number {
    return (this._config ? (this._config.title ? 2 : 0) : 0) + 3;
  }

  public setConfig(config: TodoListCardConfig): void {
    this.checkConfig(config);

    this._config = config;
    this._entityId = config.entity;
  }

  protected checkConfig(config: TodoListCardConfig): void {
    if (!config.entity || config.entity.split(".")[0] !== "todo") {
      throw new Error("Specify an entity from within the todo domain");
    }
  }

  protected getEntityId(): string | undefined {
    // not implemented, todo list should always have an entity id set;
    return undefined;
  }

  private _getCheckedItems = memoizeOne((items?: TodoItem[]): TodoItem[] =>
    items
      ? items.filter((item) => item.status === TodoItemStatus.Completed)
      : []
  );

  private _getUncheckedItems = memoizeOne((items?: TodoItem[]): TodoItem[] =>
    items
      ? items.filter((item) => item.status === TodoItemStatus.NeedsAction)
      : []
  );

  public willUpdate(
    changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    if (!this.hasUpdated) {
      if (!this._entityId) {
        this._entityId = this.getEntityId();
      }
      this._subscribeItems();
    } else if (changedProperties.has("_entityId") || !this._items) {
      this._items = undefined;
      this._subscribeItems();
    }
  }

  protected updated(changedProps: PropertyValues): void {
    super.updated(changedProps);
    if (!this._config || !this.hass) {
      return;
    }

    const oldHass = changedProps.get("hass") as HomeAssistant | undefined;
    const oldConfig = changedProps.get("_config") as
      | TodoListCardConfig
      | undefined;

    if (
      (changedProps.has("hass") && oldHass?.themes !== this.hass.themes) ||
      (changedProps.has("_config") && oldConfig?.theme !== this._config.theme)
    ) {
      applyThemesOnElement(this, this.hass.themes, this._config.theme);
    }
  }

  protected render() {
    if (!this._config || !this.hass || !this._entityId) {
      return nothing;
    }

    const stateObj = this.hass.states[this._entityId];

    if (!stateObj) {
      return html`
        <hui-warning>
          ${createEntityNotFoundWarning(this.hass, this._entityId)}
        </hui-warning>
      `;
    }
    const unavailable = isUnavailableState(stateObj.state);
    const filteredItems = this._getFilteredItemTree(this.todoInput);
    const sortedItems = this._sortItemTree(filteredItems);
    const flattenedItems = this._flattenItemTree(sortedItems);

    const checkedItems = this._getCheckedItems(flattenedItems);
    const uncheckedItems = this._getUncheckedItems(flattenedItems);

    let sortMenuIcon = mdiSort;

    if (this._sortKey === "summary") {
      sortMenuIcon =
        this._sortDirection === "asc"
          ? mdiSortAlphabeticalAscending
          : mdiSortAlphabeticalDescending;
    }

    if (this._sortKey === "due") {
      sortMenuIcon =
        this._sortDirection === "asc"
          ? mdiSortCalendarAscending
          : mdiSortCalendarDescending;
    }

    return html`
      <ha-card
        .header=${this._config.title}
        class=${classMap({
          "has-header": "title" in this._config,
        })}
      >
        <div class="menuRow">
          <div class="addRow">
            ${this.todoListSupportsFeature(
              TodoListEntityFeature.CREATE_TODO_ITEM
            )
              ? html`
                  <ha-textfield
                    class="addBox"
                    .placeholder=${this.hass!.localize(
                      "ui.panel.lovelace.cards.todo-list.add_item"
                    )}
                    @keydown=${this._addKeyPress}
                    @input=${this._todoInputChanged}
                    .disabled=${unavailable}
                  ></ha-textfield>
                  <ha-icon-button
                    class="addButton"
                    .path=${mdiPlus}
                    .title=${this.hass!.localize(
                      "ui.panel.lovelace.cards.todo-list.add_item"
                    )}
                    .disabled=${unavailable}
                    @click=${this._addItem}
                  >
                  </ha-icon-button>
                `
              : nothing}
          </div>
          <ha-button-menu @closed=${stopPropagation}>
            <ha-icon-button
              slot="trigger"
              .path=${sortMenuIcon}
            ></ha-icon-button>
            <ha-list-item
              @click=${this._sortByKey}
              graphic="icon"
              .activated=${this._sortKey == null}
            >
              <ha-svg-icon
                slot="graphic"
                .path=${mdiSort}
                .disabled=${unavailable}
              >
              </ha-svg-icon>
              ${this.hass!.localize(
                "ui.panel.lovelace.cards.todo-list.sort_by_none"
              )}
            </ha-list-item>
            <ha-list-item
              @click=${this._sortByKey}
              graphic="icon"
              .sortKey=${"summary"}
              .activated=${this._sortKey === "summary"}
            >
              ${this.hass!.localize(
                "ui.panel.lovelace.cards.todo-list.sort_by_summary"
              )}
              <ha-svg-icon
                slot="graphic"
                .path=${this._sortDirection === "asc"
                  ? mdiSortAlphabeticalAscending
                  : mdiSortAlphabeticalDescending}
                .disabled=${unavailable}
              >
              </ha-svg-icon>
            </ha-list-item>
            <ha-list-item
              @click=${this._sortByKey}
              graphic="icon"
              .activated=${this._sortKey === "due"}
              .sortKey=${"due"}
            >
              ${this.hass!.localize(
                "ui.panel.lovelace.cards.todo-list.sort_by_due_date"
              )}
              <ha-svg-icon
                slot="graphic"
                .path=${this._sortDirection === "asc"
                  ? mdiSortCalendarAscending
                  : mdiSortCalendarDescending}
                .disabled=${unavailable}
              >
              </ha-svg-icon>
            </ha-list-item>
          </ha-button-menu>
        </div>
        <ha-sortable
          handle-selector="ha-svg-icon"
          draggable-selector=".draggable"
          .disabled=${!this._reordering}
          @item-moved=${this._itemMoved}
        >
          <mwc-list wrapFocus multi>
            ${uncheckedItems.length
              ? html`
                  <div class="header" role="seperator">
                    <h2>
                      ${this.hass!.localize(
                        "ui.panel.lovelace.cards.todo-list.unchecked_items"
                      )}
                    </h2>
                  </div>
                  ${this._renderItems(uncheckedItems, unavailable)}
                `
              : html`<p class="empty">
                  ${this.hass.localize(
                    "ui.panel.lovelace.cards.todo-list.no_unchecked_items"
                  )}
                </p>`}
            ${!this._config.hide_completed && checkedItems.length
              ? html`
                  <div role="separator">
                    <div class="divider"></div>
                    <div class="header">
                      <h2>
                        ${this.hass!.localize(
                          "ui.panel.lovelace.cards.todo-list.checked_items"
                        )}
                      </h2>
                      ${this.todoListSupportsFeature(
                        TodoListEntityFeature.DELETE_TODO_ITEM
                      )
                        ? html`<ha-button-menu @closed=${stopPropagation}>
                            <ha-icon-button
                              slot="trigger"
                              .path=${mdiDotsVertical}
                            ></ha-icon-button>
                            <ha-list-item
                              @click=${this._clearCompletedItems}
                              graphic="icon"
                              class="warning"
                            >
                              ${this.hass!.localize(
                                "ui.panel.lovelace.cards.todo-list.clear_items"
                              )}
                              <ha-svg-icon
                                class="warning"
                                slot="graphic"
                                .path=${mdiDeleteSweep}
                                .disabled=${unavailable}
                              >
                              </ha-svg-icon>
                            </ha-list-item>
                          </ha-button-menu>`
                        : nothing}
                    </div>
                  </div>
                  ${this._renderItems(checkedItems, unavailable)}
                `
              : ""}
            <!-- Add a drop zone at the end of the list -->
            <div
              class="todo-item drop-zone"
              @dragover=${this._handleDragOver}
              @drop=${this._handleDrop}
              @dragleave=${this._handleDragLeave}
            ></div>
          </mwc-list>
        </ha-sortable>
      </ha-card>
    `;
  }

  private _renderItems(items: TodoItem[], unavailable = false) {
    return html`
      ${repeat(
        items,
        (item) => item.uid,
        (item) => {
          const showDelete =
            this.todoListSupportsFeature(
              TodoListEntityFeature.DELETE_TODO_ITEM
            ) &&
            !this.todoListSupportsFeature(
              TodoListEntityFeature.UPDATE_TODO_ITEM
            );
          const showReorder =
            item.status !== TodoItemStatus.Completed && this._reordering;
          const due = item.due
            ? item.due.includes("T")
              ? new Date(item.due)
              : endOfDay(new Date(`${item.due}T00:00:00`))
            : undefined;
          const today =
            due && !item.due!.includes("T") && isSameDay(new Date(), due);
          return html`
            <!-- Drag and drop functionality -->
            <div
              class="todo-item"
              item-id=${item.uid}
              draggable="true"
              @dragstart=${(e: DragEvent) => this._handleDragStart(e, item)}
              @dragover=${this._handleDragOver}
              @drop=${this._handleDrop}
              @dragleave=${this._handleDragLeave}
            >
              <ha-check-list-item
                left
                .hasMeta=${true}
                class="editRow ${classMap({
                  draggable: item.status === TodoItemStatus.NeedsAction,
                  completed: item.status === TodoItemStatus.Completed,
                  multiline: Boolean(item.description || item.due),
                  subitem:
                    Boolean(item.parent) &&
                    item.status === TodoItemStatus.NeedsAction,
                })}"
                .selected=${item.status === TodoItemStatus.Completed}
                .disabled=${unavailable ||
                !this.todoListSupportsFeature(
                  TodoListEntityFeature.UPDATE_TODO_ITEM
                )}
                item-id=${item.uid}
                .itemId=${item.uid}
                @change=${this._completeItem}
                @click=${this._openItem}
                @request-selected=${this._requestSelected}
                @keydown=${this._handleKeydown}
              >
                <div class="column">
                  <span class="summary">${item.summary}</span>
                  ${item.description
                    ? html`<ha-markdown-element
                        class="description"
                        .content=${item.description}
                      ></ha-markdown-element>`
                    : nothing}
                  ${due
                    ? html`<div class=${this.getDueClass(due)}>
                        <ha-svg-icon .path=${mdiClock}></ha-svg-icon>${today
                          ? this.hass!.localize(
                              "ui.panel.lovelace.cards.todo-list.today"
                            )
                          : html`<ha-relative-time
                              capitalize
                              .hass=${this.hass}
                              .datetime=${due}
                            ></ha-relative-time>`}
                      </div>`
                    : nothing}
                </div>
                ${showReorder
                  ? html`
                      <ha-svg-icon
                        .title=${this.hass!.localize(
                          "ui.panel.lovelace.cards.todo-list.drag_and_drop"
                        )}
                        class="reorderButton handle"
                        .path=${mdiDrag}
                        slot="meta"
                      >
                      </ha-svg-icon>
                    `
                  : showDelete
                    ? html`<ha-icon-button
                        .title=${this.hass!.localize(
                          "ui.panel.lovelace.cards.todo-list.delete_item"
                        )}
                        class="deleteItemButton"
                        .path=${mdiDelete}
                        .itemId=${item.uid}
                        slot="meta"
                        @click=${this._deleteItem}
                      >
                      </ha-icon-button>`
                    : !item.parent &&
                        this.todoListSupportsFeature(
                          TodoListEntityFeature.SET_PARENT_ON_ITEM
                        )
                      ? html`<ha-button-menu
                          @closed=${stopPropagation}
                          slot="meta"
                          ?fixed=${true}
                        >
                          <ha-icon-button
                            slot="trigger"
                            .path=${mdiDotsVertical}
                          ></ha-icon-button>
                          <ha-list-item
                            @click=${this._addSubItem}
                            graphic="icon"
                            .itemId=${item.uid}
                          >
                            Add sub item
                            <ha-svg-icon
                              slot="graphic"
                              .path=${mdiSubdirectoryArrowRight}
                              .disabled=${unavailable}
                            >
                            </ha-svg-icon>
                          </ha-list-item>
                        </ha-button-menu>`
                      : nothing}
              </ha-check-list-item>
            </div>
          `;
        }
      )}
    `;
  }

  // Helper method that determines whether due is overdue
  private getDueClass(due) {
    if (due < new Date()) {
      return "due overdue";
    }
    return "due";
  }

  private todoListSupportsFeature(feature: number): boolean {
    const entityStateObj = this.hass!.states[this._entityId!];
    return entityStateObj && supportsFeature(entityStateObj, feature);
  }

  private async _subscribeItems(): Promise<void> {
    if (this._unsubItems) {
      this._unsubItems.then((unsub) => unsub());
      this._unsubItems = undefined;
    }
    if (!this.hass || !this._entityId) {
      return;
    }
    if (!(this._entityId in this.hass.states)) {
      return;
    }
    this._unsubItems = subscribeItems(this.hass!, this._entityId, (update) => {
      this._items = update.items;
    });
  }

  private _getItem(itemId: string) {
    return this._items?.find((item) => item.uid === itemId);
  }

  private _requestSelected(ev: Event): void {
    ev.stopPropagation();
  }

  private _handleKeydown(ev) {
    if (ev.key === " ") {
      this._completeItem(ev);
      return;
    }
    if (ev.key === "Enter") {
      this._openItem(ev);
    }
  }

  private _sortByKey(ev): void {
    const sortKey = ev.currentTarget.sortKey as SortKey;

    if (this._sortKey !== sortKey) {
      this._sortDirection = "asc";
      this._sortKey = sortKey;
    } else {
      this._sortDirection = this._sortDirection === "asc" ? "desc" : "asc";
    }
  }

  private _openItem(ev): void {
    ev.stopPropagation();

    if (
      ev
        .composedPath()
        .find((el) => ["input", "a", "button"].includes(el.localName))
    ) {
      return;
    }

    const item = this._getItem(ev.currentTarget.itemId);
    showTodoItemEditDialog(this, {
      entity: this._entityId!,
      item,
    });
  }

  private async _completeItem(ev): Promise<void> {
    let focusedIndex: number | undefined;
    let list: List | undefined;
    if (ev.type === "keydown") {
      list = this.renderRoot.querySelector("mwc-list")!;
      focusedIndex = list.getFocusedItemIndex();
    }
    const item = this._getItem(ev.currentTarget.itemId);
    if (!item) {
      return;
    }
    await updateItem(this.hass!, this._entityId!, {
      uid: item.uid,
      summary: item.summary,
      status:
        item.status === TodoItemStatus.NeedsAction
          ? TodoItemStatus.Completed
          : TodoItemStatus.NeedsAction,
    });
    if (focusedIndex !== undefined && list) {
      await this.updateComplete;
      await list.updateComplete;
      list.focusItemAtIndex(focusedIndex);
    }
  }

  private async _clearCompletedItems(): Promise<void> {
    if (!this.hass) {
      return;
    }
    const checkedItems = this._getCheckedItems(this._items);
    const uids = checkedItems.map((item: TodoItem) => item.uid);
    showConfirmationDialog(this, {
      title: this.hass.localize(
        "ui.panel.lovelace.cards.todo-list.delete_confirm_title"
      ),
      text: this.hass.localize(
        "ui.panel.lovelace.cards.todo-list.delete_confirm_text",
        { number: uids.length }
      ),
      dismissText: this.hass.localize("ui.common.cancel"),
      confirmText: this.hass.localize("ui.common.delete"),
      destructive: true,
      confirm: () => {
        deleteItems(this.hass!, this._entityId!, uids);
      },
    });
  }

  private get _newItem(): HaTextField {
    return this.shadowRoot!.querySelector(".addBox") as HaTextField;
  }

  private _addSubItem(ev): void {
    ev.stopPropagation();
    const parentId = ev.currentTarget.itemId;
    showTodoItemEditDialog(this, { entity: this._entityId!, parent: parentId });
  }

  private _addItem(ev): void {
    const newItem = this._newItem;
    if (newItem.value!.length > 0) {
      createItem(this.hass!, this._entityId!, {
        summary: newItem.value!,
      });
    }

    newItem.value = "";
    if (ev) {
      newItem.focus();
    }
  }

  private _getItemTree(): Array<ParentItem> {
    const result: Array<ParentItem> = [];
    this._items?.forEach((item) => {
      const parent = result.find((it) => it.item.uid === item.parent);
      if (parent) {
        parent.children.push(item);
      } else {
        result.push({ item, children: [] });
      }
    });
    return result;
  }

  /**
   * Excludes any todo-item in the tree which does not include the `filter` parameter.
   * @param filter the search term
   * @returns the item tree
   */
  private _getFilteredItemTree(filter?: string): Array<ParentItem> {
    const itemTree = this._getItemTree();

    if (filter == null || filter.length < 1) {
      return itemTree;
    }

    return itemTree.filter(
      (it) =>
        it.item.summary.toLowerCase().includes(filter.toLowerCase()) ||
        it.children.some((child) =>
          child.summary.toLowerCase().includes(filter.toLowerCase())
        )
    );
  }

  /**
   * Sorts the todo-item tree according to `this._sortKey` and `this._sortDirection` properties.
   * @param itemTree the tree of todo-items to sort
   * @returns the sorted tree
   */
  private _sortItemTree(itemTree: Array<ParentItem>): Array<ParentItem> {
    // Compares due dates of two todo-items
    const sortDueDate = (a: TodoItem, b: TodoItem) => {
      if (!a.due && !b.due) {
        return 0;
      }
      if (!a.due) {
        return 1;
      }
      if (!b.due) {
        return -1;
      }
      const dueA = new Date(a.due);
      const dueB = new Date(b.due);
      return dueA.getTime() - dueB.getTime();
    };

    // Compares summary of two todo-items
    const sortSummary = (a: TodoItem, b: TodoItem) =>
      a?.summary.localeCompare(b.summary);

    // Choose sorting function depending on _sortKey
    if (this._sortKey != null) {
      const sortingFn = this._sortKey === "summary" ? sortSummary : sortDueDate;

      itemTree.sort((a, b) =>
        this._sortDirection === "asc"
          ? sortingFn(a.item, b.item)
          : sortingFn(b.item, a.item)
      );
      itemTree.forEach((it) => {
        it.children.sort((a, b) =>
          this._sortDirection === "asc" ? sortingFn(a, b) : sortingFn(b, a)
        );
      });
    }

    return itemTree;
  }

  private _flattenItemTree(itemTree: Array<ParentItem>): Array<TodoItem> {
    return itemTree.flatMap((it) => [it.item, ...it.children]);
  }

  private _deleteItem(ev): void {
    const item = this._getItem(ev.target.itemId);
    if (!item) {
      return;
    }
    deleteItems(this.hass!, this._entityId!, [item.uid]);
  }

  private _addKeyPress(ev): void {
    if (ev.key === "Enter") {
      this._addItem(null);
    }
  }

  private _todoInputChanged(ev): void {
    this.todoInput = ev.target.value;
  }

  private async _toggleReorder() {
    this._reordering = !this._reordering;
    this._sortKey = undefined;
  }

  private async _itemMoved(ev: CustomEvent) {
    ev.stopPropagation();
    const { oldIndex, newIndex } = ev.detail;
    this._moveItem(oldIndex, newIndex);
  }

  private async _moveItem(oldIndex: number, newIndex: number) {
    // correct index for header
    oldIndex -= 1;
    newIndex -= 1;
    const uncheckedItems = this._getUncheckedItems(this._items);
    const item = uncheckedItems[oldIndex];
    let prevItem: TodoItem | undefined;
    if (newIndex > 0) {
      if (newIndex < oldIndex) {
        prevItem = uncheckedItems[newIndex - 1];
      } else {
        prevItem = uncheckedItems[newIndex];
      }
    }

    // Optimistic change
    const itemIndex = this._items!.findIndex((itm) => itm.uid === item.uid);
    this._items!.splice(itemIndex, 1);
    if (newIndex === 0) {
      this._items!.unshift(item);
    } else {
      const prevIndex = this._items!.findIndex(
        (itm) => itm.uid === prevItem!.uid
      );
      this._items!.splice(prevIndex + 1, 0, item);
    }
    this._items = [...this._items!];

    await moveItem(this.hass!, this._entityId!, item.uid, prevItem?.uid);
  }

  /* Drag and drop functionality */
  // Drag start event to set the data to be transferred
  private _handleDragStart(e: DragEvent, _item: TodoItem) {
    // this._showDropZone = true;
    // Item id is stored in the item-id attribute of the element
    const itemId = (e.currentTarget as HTMLElement).getAttribute("item-id");
    if (!itemId) return; // Exit if itemId is null or undefined

    const draggedItem = this._getItem(itemId);
    if (!draggedItem) return; // Exit if draggedItem is null

    // Set the data to be transferred
    e.dataTransfer?.setData("text/plain", draggedItem.uid);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
    }

    _draggedItem = draggedItem;
    _fromList = this._entityId;

    // Add event listener for dragend to handle the end of the drag operation
    if (e.currentTarget) {
      e.currentTarget.addEventListener(
        "dragend",
        this._handleDragEnd.bind(this) as EventListener
      );
    }
    console.log("DRAG START");
  }

  // Drag over event to allow drop
  private _handleDragOver(e: DragEvent) {
    // Prevent default to allow drop
    e.preventDefault();
    // Set the dropEffect to move
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }

    // Remove the drop-target class from all drop targets
    const dropTargets = this.shadowRoot?.querySelectorAll(".drop-target");
    dropTargets?.forEach((target) => {
      target.classList.remove("drop-target");
    });

    // Add the drop-target class to the current target
    const target = e.currentTarget as HTMLElement;
    target.classList.add("drop-target");
    console.log("DRAG OVER");
  }

  private async _handleDrop(e: DragEvent) {
    // Prevent default to allow drop
    e.preventDefault();

    // Remove the drop-target class from all drop targets (visual feedback)
    const target = e.currentTarget as HTMLElement;
    target.classList.remove("drop-target");

    // Get the item id from the data transfer
    const uid = e.dataTransfer?.getData("text/plain");

    // Check if the uid and _draggedItem are not null
    if (uid && _draggedItem) {
      // Get the panel-todo element
      const panelTodo = document.querySelector("home-assistant")?.shadowRoot
        ?.children[0]?.shadowRoot?.children[0]?.children[1]?.children[0] as any;
      // Check if the panel-todo element is found
      if (panelTodo) {
        // Get the target list id and previous uid
        const targetListId = this._entityId;

        let previousUid: string | undefined;
        if (target.classList.contains("drop-zone")) {
          // Dropping at the end of the list
          const lastItem = this._items?.[this._items.length - 1];
          previousUid = lastItem?.uid;
        } else {
          previousUid = this._getPreviousUid(target);
        }
        // Add the item to the target list
        const newUid = await panelTodo._addItemToTargetList(
          uid,
          this._entityId
        );
        // Move the item to the target with new uid of added item
        await panelTodo.moveItemInOrder(newUid, targetListId, previousUid);
        // Delete the item from the source list
        await panelTodo._deleteItemFromList(_draggedItem.uid, _fromList);
      } else {
        console.error("ha-panel-todo element not found");
      }
    } else {
      console.error(
        "Drop event: uid or _draggedItem is null",
        uid,
        _draggedItem
      );
    }
    // Ensure _draggedItem is set to null after handling the drop event
    _draggedItem = null;
    _fromList = undefined;
    console.log("DROP");
  }

  // get the uid of the previous item in the list
  private _getPreviousUid(target: HTMLElement): string | undefined {
    const previousElement = target.previousElementSibling;
    return previousElement
      ? (previousElement.getAttribute("item-id") ?? undefined)
      : undefined;
  }

  // Handle drag leave event for visual feedback
  private _handleDragLeave(e: DragEvent) {
    const target = e.currentTarget as HTMLElement;
    target.classList.remove("drop-target");
    console.log("DRAG LEAVE");
  }

  // Handle drag end event to hide the drop zone
  private _handleDragEnd(_e: DragEvent) {
    // this._showDropZone = false;
    console.log("DRAG END");
  }

  static get styles(): CSSResultGroup {
    return css`
      ha-card {
        height: 100%;
        box-sizing: border-box;
      }

      .has-header {
        padding-top: 0;
      }

      .menuRow {
        display: flex;
        flex-direction: row;
        align-items: center;

        column-gap: 16px;

        padding: 16px;
        padding-bottom: 0;
      }

      .addRow {
        position: relative;
        flex-grow: 1;
      }

      .addRow ha-icon-button {
        position: absolute;
        right: 16px;
        inset-inline-start: initial;
        inset-inline-end: 16px;
      }

      .addRow,
      .header {
        display: flex;
        flex-direction: row;
        align-items: center;
      }

      .header {
        padding-left: 30px;
        padding-right: 16px;
        padding-inline-start: 30px;
        padding-inline-end: 16px;
        margin-top: 8px;
        justify-content: space-between;
        direction: var(--direction);
      }

      .header h2 {
        color: var(--primary-text-color);
        font-size: inherit;
        font-weight: 500;
      }

      .empty {
        padding: 16px 32px;
        display: inline-block;
      }

      .item {
        margin-top: 8px;
      }

      .subitem {
        margin-left: 24px;
      }

      ha-check-list-item {
        --mdc-list-item-meta-size: 56px;
        min-height: 56px;
        height: auto;
      }

      ha-check-list-item.multiline {
        align-items: flex-start;
        --check-list-item-graphic-margin-top: 8px;
      }

      .row {
        display: flex;
        justify-content: space-between;
      }

      .multiline .column {
        display: flex;
        flex-direction: column;
        margin-top: 18px;
        margin-bottom: 12px;
      }

      .completed .summary {
        text-decoration: line-through;
      }

      .description,
      .due {
        font-size: 12px;
        color: var(--secondary-text-color);
      }

      .description {
        white-space: initial;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        line-clamp: 3;
        -webkit-box-orient: vertical;
      }

      .description p {
        margin: 0;
      }

      .description a {
        color: var(--primary-color);
      }

      .due {
        display: flex;
        align-items: center;
      }

      .due ha-svg-icon {
        margin-right: 4px;
        margin-inline-end: 4px;
        margin-inline-start: initial;
        --mdc-icon-size: 14px;
      }

      .due.overdue {
        color: var(--warning-color);
      }

      .completed .due.overdue {
        color: var(--secondary-text-color);
      }

      .handle {
        cursor: move; /* fallback if grab cursor is unsupported */
        cursor: grab;
        height: 24px;
        padding: 16px 4px;
      }

      .deleteItemButton {
        position: relative;
        left: 8px;
        inset-inline-start: 8px;
        inset-inline-end: initial;
      }

      ha-textfield {
        flex-grow: 1;
      }

      .divider {
        height: 1px;
        background-color: var(--divider-color);
        margin: 10px 0;
      }

      .clearall {
        cursor: pointer;
      }

      .todoList {
        display: block;
        padding: 8px;
      }

      .warning {
        color: var(--error-color);
      }

      .drop-target {
        border: 2px dashed var(--primary-color);
      }

      .drop-zone {
        height: 20px;
        border: 2px dashed transparent;
      }

      .drop-zone.drop-target {
        border-color: var(--primary-color);
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hui-todo-list-card": HuiTodoListCard;
  }
}
