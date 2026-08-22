## Default Permission

Default permissions for the background-relay plugin: start/stop the stay-connected foreground service, query it, push connection-state text into its notification, and read/watch native connectivity (CDX-027)

#### This default permission set includes the following:

- `allow-start-service`
- `allow-stop-service`
- `allow-is-running`
- `allow-update-state`
- `allow-get-connectivity`
- `allow-watch-connectivity`
- `allow-unwatch-connectivity`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`background-relay:allow-get-connectivity`

</td>
<td>

Enables the get_connectivity command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:deny-get-connectivity`

</td>
<td>

Denies the get_connectivity command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:allow-is-running`

</td>
<td>

Enables the is_running command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:deny-is-running`

</td>
<td>

Denies the is_running command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:allow-start-service`

</td>
<td>

Enables the start_service command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:deny-start-service`

</td>
<td>

Denies the start_service command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:allow-stop-service`

</td>
<td>

Enables the stop_service command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:deny-stop-service`

</td>
<td>

Denies the stop_service command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:allow-unwatch-connectivity`

</td>
<td>

Enables the unwatch_connectivity command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:deny-unwatch-connectivity`

</td>
<td>

Denies the unwatch_connectivity command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:allow-update-state`

</td>
<td>

Enables the update_state command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:deny-update-state`

</td>
<td>

Denies the update_state command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:allow-watch-connectivity`

</td>
<td>

Enables the watch_connectivity command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`background-relay:deny-watch-connectivity`

</td>
<td>

Denies the watch_connectivity command without any pre-configured scope.

</td>
</tr>
</table>
