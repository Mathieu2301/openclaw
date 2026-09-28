package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.core.net.toUri

/**
 * Reuses the gateway's terminal UI and native-session setup, keeping startup
 * and terminal output on the same WebView connection.
 */
@Composable
internal fun TerminalSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
  catalogSessionStart: CatalogSessionStart? = null,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val controlPage by viewModel.gatewayControlPage.collectAsState()
  ControlUiScreenFrame(
    title = nativeString("Terminal"),
    icon = SettingsRoute.Terminal.icon,
    onBack = onBack,
    modifier = Modifier.imePadding(),
  ) {
    val page = controlPage
    if (isConnected && page != null && (catalogSessionStart == null || catalogSessionStart.gatewayBaseUrl == page.baseUrl)) {
      // The saved request ID survives restoration but distinguishes repeated explicit starts.
      key(page.baseUrl, catalogSessionStart?.requestId) {
        ControlUiWebView(
          page = page,
          url = terminalUrl(page.baseUrl, catalogSessionStart),
          modifier = Modifier.fillMaxSize(),
        )
      }
    } else {
      ControlUiUnavailable(
        title = nativeString("Terminal needs a connected gateway"),
        detail = nativeString("Connect to your gateway to open a shell in the agent workspace."),
      )
    }
  }
}

/** Builds the terminal or native-session setup route without gateway credentials in the URL. */
internal fun terminalUrl(
  baseUrl: String,
  catalogSessionStart: CatalogSessionStart? = null,
): String =
  baseUrl
    .trimEnd('/')
    .toUri()
    .buildUpon()
    .clearQuery()
    .fragment(null)
    .apply {
      if (catalogSessionStart == null) {
        appendPath("focus")
        appendPath("terminal")
      } else {
        appendPath("new")
        if (catalogSessionStart.agentId.isNotEmpty()) appendQueryParameter("agent", catalogSessionStart.agentId)
        appendQueryParameter("catalog", catalogSessionStart.catalogId)
      }
    }.build()
    .toString()
