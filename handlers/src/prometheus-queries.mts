export function getCpuQuery(
  platform: string | null,
  escapedPrivateIp: string,
  instanceId: string,
  threshold: number,
): string {
  if (platform?.toLowerCase().includes('windows')) {
    return `100 - (rate(windows_cpu_time_total{instance=~"(${escapedPrivateIp}.*|${instanceId})", mode="idle"}[30s]) * 100) > ${threshold}`;
  } else {
    return `100 - (rate(node_cpu_seconds_total{mode="idle", instance=~"(${escapedPrivateIp}.*|${instanceId})"}[30s]) * 100) > ${threshold}`;
  }
}

export function getMemoryQuery(
  platform: string | null,
  escapedPrivateIp: string,
  instanceId: string,
  threshold: number,
): string {
  if (platform?.toLowerCase().includes('windows')) {
    return `100 - ((windows_os_virtual_memory_free_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / windows_os_virtual_memory_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${threshold}`;
  } else {
    return `100 - ((node_memory_MemAvailable_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / node_memory_MemTotal_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${threshold}`;
  }
}

export function getStorageQuery(
  platform: string | null,
  escapedPrivateIp: string,
  instanceId: string,
  threshold: number,
): string {
  if (platform?.toLowerCase().includes('windows')) {
    return `100 - ((windows_logical_disk_free_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / windows_logical_disk_size_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${threshold}`;
  } else {
    return `100 - ((node_filesystem_free_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"} / node_filesystem_size_bytes{instance=~"(${escapedPrivateIp}.*|${instanceId})"}) * 100) > ${threshold}`;
  }
}
