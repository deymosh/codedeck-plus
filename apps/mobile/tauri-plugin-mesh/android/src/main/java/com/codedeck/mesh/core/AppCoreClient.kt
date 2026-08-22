package com.codedeck.mesh.core

import org.json.JSONObject
import org.json.JSONArray
import org.nostrvpn.app.core.NativeCore

class AppCoreClient(private val dataDir: String, appVersion: String) : AutoCloseable {
    private var handle: Long = NativeCore.appNew(dataDir, appVersion)

    fun state(): AppState = parseAppState(NativeCore.stateJson(requireHandle()))

    fun refresh(): AppState = parseAppState(NativeCore.refreshJson(requireHandle()))

    fun dispatch(action: JSONObject): AppState =
        parseAppState(NativeCore.dispatchJson(requireHandle(), action.toString()))

    // Raw-JSON passthroughs for the Tauri plugin bridge: the JS layer consumes the engine's
    // stateJson (UiState) directly, so we avoid the parse → re-serialize round-trip.
    fun stateJsonRaw(): String = NativeCore.stateJson(requireHandle())

    fun dispatchRaw(actionJson: String): String =
        NativeCore.dispatchJson(requireHandle(), actionJson)

    fun qrMatrix(invite: String): JSONObject = JSONObject(NativeCore.qrMatrixJson(invite))

    fun decodeQrImage(path: String): JSONObject = JSONObject(NativeCore.decodeQrImageJson(path))

    fun mobileTunnelConfigJson(): String = NativeCore.mobileTunnelConfigJson(dataDir)

    override fun close() {
        val current = handle
        if (current != 0L) {
            NativeCore.appFree(current)
            handle = 0
        }
    }

    private fun requireHandle(): Long {
        check(handle != 0L) { "native app core is closed" }
        return handle
    }
}

object NativeActions {
    fun connectVpn() = action("connect_vpn")
    fun disconnectVpn() = action("disconnect_vpn")
    fun importInvite(invite: String) = action("import_network_invite", "invite" to invite)
    fun startInviteBroadcast() = action("start_invite_broadcast")
    fun stopInviteBroadcast() = action("stop_invite_broadcast")
    fun resetNetworkInvite(networkId: String) = action("reset_network_invite", "networkId" to networkId)
    fun startNearbyDiscovery() = action("start_nearby_discovery")
    fun stopNearbyDiscovery() = action("stop_nearby_discovery")
    fun addNetwork(name: String) = action("add_network", "name" to name)
    fun manualAddNetwork(adminNpub: String, meshNetworkId: String) =
        action("manual_add_network", "adminNpub" to adminNpub, "meshNetworkId" to meshNetworkId)

    fun requestNetworkJoin(networkId: String) =
        action("request_network_join", "networkId" to networkId)

    fun setNetworkEnabled(networkId: String, enabled: Boolean) =
        action("set_network_enabled", "networkId" to networkId, "enabled" to enabled)

    fun setJoinRequests(networkId: String, enabled: Boolean) =
        action("set_network_join_requests_enabled", "networkId" to networkId, "enabled" to enabled)

    fun acceptJoinRequest(networkId: String, requesterNpub: String) =
        action("accept_join_request", "networkId" to networkId, "requesterNpub" to requesterNpub)

    fun rejectJoinRequest(networkId: String, requesterNpub: String) =
        action("reject_join_request", "networkId" to networkId, "requesterNpub" to requesterNpub)

    fun removeNetwork(networkId: String) = action("remove_network", "networkId" to networkId)

    fun setParticipantEndpointHints(npub: String, endpointHints: List<String>) =
        action("set_participant_endpoint_hints", "npub" to npub, "endpointHints" to endpointHints)

    fun updateSettings(vararg settings: Pair<String, Any?>): JSONObject =
        JSONObject()
            .put("type", "update_settings")
            .put(
                "patch",
                JSONObject().apply {
                    settings.forEach { (key, value) ->
                        put(key, if (value is List<*>) JSONArray(value) else value)
                    }
                },
            )

    private fun action(type: String, vararg fields: Pair<String, Any?>): JSONObject =
        JSONObject().put("type", type).apply {
            fields.forEach { (key, value) -> put(key, if (value is List<*>) JSONArray(value) else value) }
        }
}
