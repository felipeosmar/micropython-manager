/**
 * Tipos e interfaces para o MicroPython Manager
 */

export interface SerialPortInfo {
    path: string;
    manufacturer?: string;
    serialNumber?: string;
    pnpId?: string;
    locationId?: string;
    productId?: string;
    vendorId?: string;
}

export interface ESP32Device {
    id: string;
    name: string;
    port: string;
    baudRate: number;
    isConnected: boolean;
    micropythonVersion?: string;
    lastActivity: Date;
}

export interface MicroPythonREPL {
    deviceId: string;
    terminal: any; // vscode.Terminal
    isActive: boolean;
}

export interface ConnectionOptions {
    path: string;
    baudRate: number;
    dataBits?: 8 | 7 | 6 | 5;
    stopBits?: 1 | 2;
    parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
    autoOpen?: boolean;
}

export enum DeviceStatus {
    DISCONNECTED = 'disconnected',
    CONNECTING = 'connecting',
    CONNECTED = 'connected',
    ERROR = 'error'
}

export interface ESP32File {
    name: string;
    path: string;
    isDirectory: boolean;
    size?: number;
    deviceId: string;
    depth?: number;
}

export interface DeviceTreeItem {
    device?: ESP32Device;
    file?: ESP32File;
    status?: DeviceStatus;
    type: 'device' | 'file' | 'directory';
}
