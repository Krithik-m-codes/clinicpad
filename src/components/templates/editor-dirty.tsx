"use client";

import { createContext, useContext } from "react";

/** True while the editor holds changes that are not saved yet: the panels below it read only the saved draft. */
const EditorDirtyContext = createContext(false);

export const EditorDirtyProvider = EditorDirtyContext.Provider;

export function useEditorDirty(): boolean {
  return useContext(EditorDirtyContext);
}
