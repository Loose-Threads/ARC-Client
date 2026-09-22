// ====
// Reactive theme flag composable.
// Returns `isDarkTheme` which is always true (the app is dark-only) but
// kept reactive in case future themes include light palettes. Pages that
// use it (Hyperate, AutoStatus, OscLeash) get a stable `true` value with no
// runtime cost beyond an empty MutationObserver hook.
// ====
import { onMounted, onUnmounted, ref } from 'vue'

export function useTheme() {
  const isDarkTheme = ref(true)
  let observer: MutationObserver | null = null
  function syncThemeState() {
    if (typeof document === 'undefined') return
    // The app is permanently dark; this is a no-op for now but kept so
    // the public API doesn't change if a future light theme is added.
    isDarkTheme.value = true
  }
  function startThemeObserver() {
    syncThemeState()
  }
  function stopThemeObserver() {
    observer?.disconnect()
    observer = null
  }
  onMounted(startThemeObserver)
  onUnmounted(stopThemeObserver)
  return { isDarkTheme, syncThemeState, startThemeObserver, stopThemeObserver }
}
