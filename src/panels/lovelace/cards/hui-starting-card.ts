import "@material/mwc-button/mwc-button";
import { STATE_NOT_RUNNING } from "home-assistant-js-websocket";
import type { CSSResultGroup, PropertyValues } from "lit";
import { css, html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators";
import { fireEvent } from "../../../common/dom/fire_event";
import "../../../components/ha-card";
import "../../../components/ha-circular-progress";
import type { LovelaceCardConfig } from "../../../data/lovelace/config/card";
import type { HomeAssistant } from "../../../types";
import type { LovelaceCard } from "../types";

@customElement("hui-starting-card")
export class HuiStartingCard extends LitElement implements LovelaceCard {
  @property({ attribute: false }) public hass?: HomeAssistant;

  public getCardSize(): number {
    return 2;
  }

  public setConfig(_config: LovelaceCardConfig): void {
    // eslint-disable-next-line
  }

  protected updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    if (!changedProperties.has("hass") || !this.hass!.config) {
      return;
    }

    if (this.hass!.config.state !== STATE_NOT_RUNNING) {
      fireEvent(this, "config-refresh");
    }
  }

  protected render() {
    if (!this.hass) {
      return nothing;
    }

    return html`
      <div class="content">
        <ha-circular-progress indeterminate></ha-circular-progress>
        ${this.hass.localize("ui.panel.lovelace.cards.starting.description")}
      </div>
    `;
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: block;
        height: calc(100vh - var(--header-height));
      }
      ha-circular-progress {
        margin-bottom: 20px;
      }
      .content {
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hui-starting-card": HuiStartingCard;
  }
}
