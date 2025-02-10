// EC2 Prometheus queries for prometheus rules
export function EC2getCpuQuery(
  platform: string | null,
  escapedPrivateIp: string,
  instanceId: string,
  threshold: number,
): string {
  if (platform?.toLowerCase().includes('windows')) {
    return `100 - (rate(windows_cpu_time_total{instance=~"(${escapedPrivateIp}.*|${instanceId})", mode="idle"}[180s]) * 100) > ${threshold}`;
  } else {
    return `100 - (rate(node_cpu_seconds_total{mode="idle", instance=~"(${escapedPrivateIp}.*|${instanceId})"}[180s]) * 100) > ${threshold}`;
  }
}

export function EC2getMemoryQuery(
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

export function EC2getStorageQuery(
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
