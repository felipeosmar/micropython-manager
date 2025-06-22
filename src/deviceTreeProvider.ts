import * as vscode from 'vscode';
import { ESP32Device, DeviceStatus, DeviceTreeItem, ESP32File } from './types';
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
    
    // Cache de arquivos por dispositivo
    private fileCache: Map<string, ESP32File[]> = new Map();

    constructor(private deviceManager: DeviceManager) {
        // Escutar mudanças nos dispositivos e atualizar a árvore
        setInterval(() => {
            this.refresh();
        }, 3000); // Atualizar a cada 3 segundos
        
        // Escutar mudanças do device manager
        this.setupDeviceChangeListener();
    }

    /**
     * Configura listener para mudanças nos dispositivos
     */
    private setupDeviceChangeListener(): void {
        // Monitorar mudanças de conexão para atualizar automaticamente
        const checkDeviceChanges = () => {
            const currentDevices = this.deviceManager.getConnectedDevices();
            let hasChanges = false;
            
            // Verificar se algum dispositivo foi conectado/desconectado
            currentDevices.forEach(device => {
                const cacheKey = `${device.id}:/`;
                if (device.isConnected && !this.fileCache.has(cacheKey)) {
                    // Novo dispositivo conectado - forçar carregamento de arquivos
                    this.loadDeviceFiles(device.id);
                    hasChanges = true;
                }
            });
            
            if (hasChanges) {
                this.refresh();
            }
        };
        
        // Verificar mudanças a cada 2 segundos
        setInterval(checkDeviceChanges, 2000);
    }

    /**
     * Carrega arquivos de um dispositivo específico
     */
    private async loadDeviceFiles(deviceId: string): Promise<void> {
        try {
            const files = await this.deviceManager.getFileStructure(deviceId);
            const cacheKey = `${deviceId}:/`;
            this.fileCache.set(cacheKey, files);
        } catch (error) {
            console.log(`Erro ao carregar arquivos do dispositivo ${deviceId}:`, error);
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * Limpa o cache de arquivos para um dispositivo específico
     */
    clearFileCache(deviceId?: string): void {
        if (deviceId) {
            // Limpar cache apenas para o dispositivo específico
            const keysToDelete = Array.from(this.fileCache.keys()).filter(key => key.startsWith(`${deviceId}:`));
            keysToDelete.forEach(key => this.fileCache.delete(key));
        } else {
            // Limpar todo o cache
            this.fileCache.clear();
        }
        this.refresh();
    }

    /**
     * Força atualização dos arquivos de um dispositivo
     */
    refreshDeviceFiles(deviceId: string): void {
        this.clearFileCache(deviceId);
    }

    getTreeItem(element: DeviceTreeItem): vscode.TreeItem {
        if (element.type === 'device' && element.device) {
            const treeItem = new vscode.TreeItem(
                element.device.name, 
                element.device.isConnected ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
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
        } else if (element.file) {
            const treeItem = new vscode.TreeItem(
                element.file.name,
                element.file.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            );

            // Configurar ícone baseado no tipo
            if (element.file.isDirectory) {
                treeItem.iconPath = new vscode.ThemeIcon('folder');
            } else {
                // Ícone baseado na extensão do arquivo
                if (element.file.name.endsWith('.py')) {
                    treeItem.iconPath = new vscode.ThemeIcon('file-code');
                } else if (element.file.name.endsWith('.json')) {
                    treeItem.iconPath = new vscode.ThemeIcon('json');
                } else {
                    treeItem.iconPath = new vscode.ThemeIcon('file');
                }
            }

            // Configurar descrição com tamanho do arquivo
            if (!element.file.isDirectory && element.file.size) {
                treeItem.description = `${element.file.size} bytes`;
            }

            // Configurar tooltip
            treeItem.tooltip = new vscode.MarkdownString(
                `**${element.file.name}**\n\n` +
                `• **Caminho:** ${element.file.path}\n` +
                `• **Tipo:** ${element.file.isDirectory ? 'Diretório' : 'Arquivo'}\n` +
                (element.file.size ? `• **Tamanho:** ${element.file.size} bytes\n` : '')
            );

            // Configurar contexto para menus
            treeItem.contextValue = element.file.isDirectory ? 'directory' : 'file';

            return treeItem;
        }

        // Fallback
        return new vscode.TreeItem('Erro', vscode.TreeItemCollapsibleState.None);
    }

    getChildren(element?: DeviceTreeItem): Thenable<DeviceTreeItem[]> {
        if (!element) {
            // Retornar dispositivos raiz
            const devices = this.deviceManager.getConnectedDevices();
            return Promise.resolve(
                devices.map((device: ESP32Device) => ({
                    device,
                    status: device.isConnected ? DeviceStatus.CONNECTED : DeviceStatus.DISCONNECTED,
                    type: 'device' as const
                }))
            );
        } else if (element.type === 'device' && element.device && element.device.isConnected) {
            // Retornar arquivos do dispositivo
            const cacheKey = `${element.device.id}:/`;
            
            // Verificar cache primeiro
            if (this.fileCache.has(cacheKey)) {
                const cachedFiles = this.fileCache.get(cacheKey)!;
                return Promise.resolve(
                    cachedFiles.map((file: ESP32File) => ({
                        file,
                        type: file.isDirectory ? 'directory' as const : 'file' as const
                    }))
                );
            }
            
            // Carregar arquivos do dispositivo
            return this.deviceManager.getFileStructure(element.device.id)
                .then((files: ESP32File[]) => {
                    // Atualizar cache
                    this.fileCache.set(cacheKey, files);
                    
                    return files.map((file: ESP32File) => ({
                        file,
                        type: file.isDirectory ? 'directory' as const : 'file' as const
                    }));
                })
                .catch((error) => {
                    console.log(`Erro ao carregar estrutura de arquivos: ${error}`);
                    // Em caso de erro, mostrar item informativo
                    return [{
                        file: {
                            name: 'Erro ao carregar arquivos',
                            path: '/error',
                            isDirectory: false,
                            deviceId: element.device!.id
                        },
                        type: 'file' as const
                    }];
                });
        } else if (element.type === 'directory' && element.file) {
            // Retornar conteúdo do diretório
            const cacheKey = `${element.file.deviceId}:${element.file.path}`;
            
            // Verificar cache primeiro
            if (this.fileCache.has(cacheKey)) {
                const cachedFiles = this.fileCache.get(cacheKey)!;
                return Promise.resolve(
                    cachedFiles.map((file: ESP32File) => ({
                        file,
                        type: file.isDirectory ? 'directory' as const : 'file' as const
                    }))
                );
            }
            
            return this.deviceManager.getFileStructure(element.file.deviceId, element.file.path)
                .then((files: ESP32File[]) => {
                    // Atualizar cache
                    this.fileCache.set(cacheKey, files);
                    
                    return files.map((file: ESP32File) => ({
                        file,
                        type: file.isDirectory ? 'directory' as const : 'file' as const
                    }));
                })
                .catch((error) => {
                    console.log(`Erro ao carregar diretório ${element.file?.path}: ${error}`);
                    return [];
                });
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
