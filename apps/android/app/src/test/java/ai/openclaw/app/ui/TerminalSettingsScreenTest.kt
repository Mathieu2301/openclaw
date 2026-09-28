package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TerminalSettingsScreenTest {
  @Test
  fun catalogStartUsesNewSessionRouteWithoutCredentialsOrInheritedQuery() {
    val baseUrl = "https://gateway.example.com:8443/openclaw/"
    assertEquals(
      "https://gateway.example.com:8443/openclaw/new?agent=research&catalog=codex",
      terminalUrl("$baseUrl?discard=true#old", CatalogSessionStart(baseUrl, "research", "codex")),
    )
  }

  @Test
  fun terminalUrlBuildsCanonicalFocusPath() {
    val cases =
      listOf(
        "https://gateway.example.com:8443" to
          "https://gateway.example.com:8443/focus/terminal",
        "https://gateway.example.com:8443/openclaw/" to
          "https://gateway.example.com:8443/openclaw/focus/terminal",
      )

    cases.forEach { (baseUrl, expected) ->
      assertEquals(baseUrl, expected, terminalUrl(baseUrl))
    }
  }
}
