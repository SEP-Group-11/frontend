import type { PropertyValues } from "lit";
import type { HASSDomEvent } from "../common/dom/fire_event";
import { makeDialogManager, showDialog } from "../dialogs/make-dialog-manager";
import type { Constructor } from "../types";
import type { HassBaseEl } from "./hass-base-mixin";

interface RegisterDialogParams {
  dialogShowEvent: keyof HASSDomEvents;
  dialogTag: keyof HTMLElementTagNameMap;
  dialogImport: () => Promise<unknown>;
  addHistory?: boolean;
}

declare global {
  // for fire event
  interface HASSDomEvents {
    "register-dialog": RegisterDialogParams;
  }
  // for add event listener
  interface HTMLElementEventMap {
    "register-dialog": HASSDomEvent<RegisterDialogParams>;
  }
}

export const dialogManagerMixin = <T extends Constructor<HassBaseEl>>(
  superClass: T
) =>
  class extends superClass {
    protected firstUpdated(changedProps: PropertyValues) {
      super.firstUpdated(changedProps);
      // deprecated
      this.addEventListener("register-dialog", (e) =>
        this.registerDialog(e.detail)
      );
      makeDialogManager(this, this.shadowRoot!);
    }

    private registerDialog({
      dialogShowEvent,
      dialogTag,
      dialogImport,
      addHistory = true,
    }: RegisterDialogParams) {
      this.addEventListener(dialogShowEvent, (showEv) => {
        showDialog(
          this,
          this.shadowRoot!,
          dialogTag,
          (showEv as HASSDomEvent<unknown>).detail,
          dialogImport,
          addHistory
        );
      });
    }
  };
