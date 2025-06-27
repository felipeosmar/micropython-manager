import * as vscode from 'vscode';
import { DeviceManager } from './deviceManager';
import { ESP32File } from './types';

export class FileManager {
    constructor(private deviceManager: DeviceManager) {}

    /**
     * Lista arquivos e diretórios de forma eficiente em um caminho específico no dispositivo.
     */
    async listFiles(deviceId: string, remotePath: string = '/'): Promise<ESP32File[]> {
        // Este script usa os.ilistdir para obter nome, tipo e tamanho de uma só vez,
        // e ujson para formatar a saída, o que é muito mais eficiente e robusto.
        const command = `
import os, ujson
def list_dir(path):
    try:
        entries = []
        for name, type, _, size in os.ilistdir(path):
            entries.append({
                "name": name,
                "is_dir": (type & 0x4000) != 0,
                "size": size
            })
        print(ujson.dumps(entries))
    except OSError:
        print("[]")
list_dir('${remotePath}')
`;
        const rawOutput = await this.deviceManager.executeCommand(deviceId, command);

        // Extrai o JSON da saída do REPL. O JSON estará entre '[' e ']'.
        const jsonMatch = rawOutput.match(/(\[.*\])/s);
        if (jsonMatch && jsonMatch[1]) {
            try {
                const parsed = JSON.parse(jsonMatch[1]);
                return parsed.map((item: any): ESP32File => ({
                    name: item.name,
                    path: remotePath === '/' ? `/${item.name}` : `${remotePath}/${item.name}`,
                    isDirectory: item.is_dir,
                    size: item.size,
                    deviceId: deviceId,
                }));
            } catch (e) {
                console.error("Erro ao analisar JSON da lista de arquivos:", e, "Saída recebida:", rawOutput);
                throw new Error('Falha ao analisar a lista de arquivos retornada pelo dispositivo.');
            }
        }
        
        console.warn("Não foi possível encontrar JSON na saída do comando listFiles:", rawOutput);
        return [];
    }

    /**
     * Deleta um arquivo ou um diretório (recursivamente) no dispositivo.
     */
    async deleteFile(deviceId: string, remotePath: string): Promise<void> {
        const command = `
import os
def rm_recursive(path):
    try:
        # Checa se é diretório
        if (os.stat(path)[0] & 0x4000): 
            for f in os.listdir(path):
                rm_recursive(path + '/' + f)
            os.rmdir(path)
        else: # É arquivo
            os.remove(path)
        print("OK")
    except OSError as e:
        print("Error: " + str(e))
rm_recursive('${remotePath}')
`;
        const output = await this.deviceManager.executeCommand(deviceId, command);
        if (output.includes("Error")) {
            throw new Error(`Não foi possível deletar '${remotePath}': ${output}`);
        }
    }

    /**
     * Lê o conteúdo de um arquivo do dispositivo para download.
     */
    async downloadFile(deviceId: string, remotePath: string): Promise<string> {
        // Entra no modo raw para receber os dados do arquivo sem interferência do REPL.
        await this.deviceManager.executeCommand(deviceId, '\x01'); // Ctrl+A

        const command = `
with open('${remotePath}', 'r') as f:
    print(f.read())
`;
        // Envia o comando de leitura.
        await this.deviceManager.executeCommand(deviceId, command);
        
        // Sai do modo raw e captura a saída.
        const output = await this.deviceManager.executeCommand(deviceId, '\x04'); // Ctrl+D para executar e obter a saída

        // A saída real do arquivo estará contida na resposta do comando Ctrl+D.
        // Precisamos limpá-la de possíveis artefatos do REPL.
        const cleanOutput = output.replace('OK', '').replace(/>>>/g, '').trim();
        return cleanOutput;
    }
}