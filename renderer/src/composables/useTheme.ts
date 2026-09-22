// ====
// Shared dark-theme observation composable.
// The app is dark-only; `dark-theme` is permanently set on <body> at boot.
// This composable still watches the class for any edge case where pages
// need to apply a class binding reactively (e.g. Hyperate, AutoStatus,
// OscLeash use the returned `isDarkTheme` flag for dark-specific styling).
// ====
import { onMounted, onUnmounted, ref } from 'vue'

export function useTheme() {
  const isDarkTheme = ref(false)
  let observer: MutationObserver | null = null
  function syncThemeState() {
    if (typeof document === 'undefined') return
    isDarkTheme.value = document.body.classList.contains('dark-theme')
  }
  function startThemeObserver() {
    syncThemeState()
    if (typeof document === 'undefined') return
    observer = new MutationObserver(syncThemeState)
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  }
  function stopThemeObserver() {
    observer?.disconnect()
    observer = null
  }
  onMounted(startThemeObserver)
  onUnmounted(stopThemeObserver)
  return { isDarkTheme, syncThemeState, startThemeObserver, stopThemeObserver }
}
