SHELL += -eu

build: clear
	env CGO_ENABLED=0 GOARCH=amd64 GOOS=linux go build -o ./dist/cr/trigger-fn ./src/constructs/trigger-fn
	env CGO_ENABLED=0 GOARCH=amd64 GOOS=linux go build -o ./dist/cr/webhook-manager-fn ./src/constructs/webhook-manager-fn
	env CGO_ENABLED=0 GOARCH=amd64 GOOS=linux go build -o ./dist/lambda/updater ./src/lambda/updater
	env CGO_ENABLED=0 GOARCH=amd64 GOOS=linux go build -o ./dist/lambda/version ./src/lambda/version

	strip ./dist/lambda/*
	strip ./dist/cr/*
	zip ./dist/webhook-manager-fn.zip ./dist/cr/webhook-manager-fn
	zip ./dist/trigger-fn.zip ./dist/cr/trigger-fn
	zip ./dist/updater.zip ./dist/lambda/updater
	zip ./dist/version.zip ./dist/lambda/version

clear: gendirectory
	rm -rf ./dist/*

dia:
	cd docs && npx cdk-dia --tree ../cdk.out/tree.json  \
		--include PAYLOADCMS-CICD-STACK \
		--include PAYLOADCMS-CICD-STACK/Dev/CmsStack \
		--include PAYLOADCMS-CICD-STACK/Dev/CmsPipeline \
		--include PAYLOADCMS-CICD-STACK/Dev/CmsWaf \
		--include PAYLOADCMS-CICD-STACK/Dev/CmsAppWrapper

gendirectory:
	mkdir -p dist
