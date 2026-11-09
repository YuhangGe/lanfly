import { registerErrorMessages } from './action';

export function registerErrors() {
  registerErrorMessages({
    INVALID_INPUT: '请求参数不正确，请刷新页面后重试',
    INTERNAL_ERROR: '本地服务出现异常，请查看终端日志',
    PEER_NOT_FOUND: '设备已离线或不存在',
    PEER_OFFLINE: '对方当前离线',
    PEER_UNREACHABLE: '无法连接对方，请检查网络或防火墙',
    PEER_UNAUTHORIZED: '对方拒绝了连接，密码可能不一致',
    PEER_PROTOCOL: '对方返回了无法识别的数据，版本可能不兼容',
    PEER_HTTP_ERROR: '对方服务返回错误',
    SECRET_MISMATCH: '密码房间不一致，无法互相发现',
    SELF_CONNECT: '不能连接到本机',
    ADDRESS_INVALID: '地址格式不正确，请输入 IP、主机名或 IP:端口',
    MESSAGE_NOT_FOUND: '消息不存在',
    MESSAGE_NOT_RETRYABLE: '这条消息无法重试',
    TRANSFER_NOT_FOUND: '传输不存在',
    TRANSFER_STATE: '传输状态已变化，请刷新页面',
    TRANSFER_DUPLICATE: '重复的传输请求',
    TRANSFER_TOKEN_INVALID: '传输凭证无效',
    TRANSFER_CANCELED: '传输已取消',
    TRANSFER_UPLOAD_FAILED: '文件发送失败',
    DOWNLOAD_DIR_ERROR: '无法创建下载目录',
    DISK_ERROR: '保存文件失败，请检查磁盘空间和权限',
    BAD_REQUEST: '请求格式不正确',
    FORBIDDEN: '本地接口拒绝了该请求',
  });
}
