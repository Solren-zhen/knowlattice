-- 晶格 · KnowLattice 一键启动：调用项目里的 scripts/launch-latest.sh
-- 该脚本会重新构建最新版 → 重启本地服务(固定 5199 端口，保持原有笔记数据) → 打开浏览器
try
	do shell script "/Users/jophy/Desktop/medvault-main/scripts/launch-latest.sh"
on error errMsg number errNum
	if errNum is 2 then
		display dialog "本次重新构建失败，已用上一次成功构建的版本打开。" & return & return & "详情：/tmp/medvault-build.log" buttons {"好"} default button 1 with icon caution
	else if errNum is 3 then
		display dialog "找不到项目或依赖。" & return & return & "请确认 /Users/jophy/Desktop/medvault-main 存在，并在其中执行过 npm install。" buttons {"好"} default button 1 with icon stop
	else if errNum is 4 then
		display dialog "构建失败，且没有可用的构建产物。" & return & return & "详情：/tmp/medvault-build.log" buttons {"好"} default button 1 with icon stop
	else if errNum is 5 then
		display dialog "本地服务启动超时。" & return & return & "详情：/tmp/medvault-preview.log" buttons {"好"} default button 1 with icon stop
	else
		display dialog "启动失败：" & errMsg buttons {"好"} default button 1 with icon stop
	end if
end try
