import * as vscode from 'vscode';
import { ESP32Device, DeviceStatus, DeviceTreeItem } from './types';
import { DeviceManager } from './deviceManager';

/**
 * Provider para visualização em árvore dos dispositivos ESP32
 * 
 * Problema: Necessidade de interface visual para gerenciar múltiplos dispositivos
 * Solução: TreeDataProvider customizado que mostra status e permite ações
 * Exemplo: Lista dispositivos conectados com ícones de status e botões de ação
 */
export class DeviceTreeProvider implements vscode.TreeDataProvider<DeviceTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<DeviceTreeItem | undefined | null | void> = new vscode.EventEmitter<DeviceTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<DeviceTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    constructor(private deviceManager: DeviceManager) {
        // Escutar mudanças nos dispositivos e atualizar a árvore
        setInterval(() => {
            this.refresh();
        }, 2000); // Atualizar a cada 2 segundos
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: DeviceTreeItem): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(
            element.device.name, 
            vscode.TreeItemCollapsibleState.None
        );

        // Configurar ícone baseado no status
        treeItem.iconPath = this.getDeviceIcon(element.device.isConnected);
        
        // Configurar descrição com informações do dispositivo
        const description = [
            element.device.port,
            `${element.device.baudRate} baud`,
            element.device.micropythonVersion ? `v${element.device.micropythonVersion}` : ''
        ].filter(Boolean).join(' • ');
        
        treeItem.description = description;

        // Configurar tooltip com informações detalhadas
        treeItem.tooltip = new vscode.MarkdownString(
            `**${element.device.name}**\n\n` +
            `• **Porta:** ${element.device.port}\n` +
            `• **Baud Rate:** ${element.device.baudRate}\n` +
            `• **Status:** ${element.device.isConnected ? 'Conectado' : 'Desconectado'}\n` +
            `• **MicroPython:** ${element.device.micropythonVersion || 'Não detectado'}\n` +
            `• **Última Atividade:** ${element.device.lastActivity.toLocaleString()}`
        );

        // Configurar contexto para menus
        treeItem.contextValue = element.device.isConnected ? 'connectedDevice' : 'disconnectedDevice';

        return treeItem;
    }

    getChildren(element?: DeviceTreeItem): Thenable<DeviceTreeItem[]> {
        if (!element) {
            // Retornar dispositivos raiz
            const devices = this.deviceManager.getConnectedDevices();
            return Promise.resolve(
                devices.map((device: ESP32Device) => ({
                    device,
                    status: device.isConnected ? DeviceStatus.CONNECTED : DeviceStatus.DISCONNECTED
                }))
            );
        }
        
        return Promise.resolve([]);
    }

    /**
     * Obtém ícone apropriado para o dispositivo baseado no status
     * 
     * Problema: Usuário precisa identificar rapidamente status dos dispositivos
     * Solução: Ícones visuais claros para cada estado
     * Exemplo: Círculo verde para conectado, vermelho para erro, cinza para desconectado
     */
    private getDeviceIcon(isConnected: boolean): vscode.ThemeIcon {
        if (isConnected) {
            return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
        } else {
            return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.red'));
        }
    }
}
